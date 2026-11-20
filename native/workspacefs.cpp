// cere-workspacefs: Cere's confined filesystem helper for Workbench file tools.
//
// Every path is resolved relative to an open root directory with openat2(RESOLVE_BENEATH |
// RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS), so "..", absolute paths and symbolic links (including a
// parent swapped for a link between checks) cannot lead outside the root. The root itself is opened
// without following links and must still be the directory the broker recorded (device and inode).
// Files are first opened with O_PATH and checked to be regular before any data is read, so a FIFO,
// socket or device is never opened for reading. New names are created with O_EXCL and moved into place
// with RENAME_NOREPLACE (or link(2)), never with an overwriting rename; a replacement is checked
// against the expected content hash immediately before it is renamed over the old name. Replacing a
// name never writes through an existing inode, so other hard links to the old file keep their content.
//
// What this cannot do: an editor outside Cere can still change a file between the final hash check and
// the rename. That window is short but real; it is reported, not hidden.
//
// Usage: cere-workspacefs OP ARGS... ; one JSON object on stdout. Expected failures exit 0 with
// {"ok":false,"code":...}; only usage errors and crashes exit non-zero.
#include <linux/openat2.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <dirent.h>
#include <fcntl.h>
#include <fnmatch.h>
#include <unistd.h>
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif

namespace {

struct Failure { std::string code, message; };
[[noreturn]] void fail(const std::string &code, const std::string &message) { throw Failure{code, message}; }

class Fd {
public:
    explicit Fd(int value = -1) : fd(value) {}
    Fd(const Fd &) = delete;
    Fd &operator=(const Fd &) = delete;
    Fd(Fd &&other) noexcept : fd(other.fd) { other.fd = -1; }
    Fd &operator=(Fd &&other) noexcept { if (this != &other) { reset(); fd = other.fd; other.fd = -1; } return *this; }
    ~Fd() { reset(); }
    int get() const { return fd; }
    void reset() { if (fd >= 0) ::close(fd); fd = -1; }
private:
    int fd;
};

// ---------- SHA-256 (FIPS 180-4) ----------
class Sha256 {
public:
    Sha256() { reset(); }
    void reset() {
        static const uint32_t init[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
        std::memcpy(h, init, sizeof h); length = 0; used = 0;
    }
    void update(const unsigned char *data, size_t size) {
        length += size;
        while (size) {
            size_t take = std::min(size, sizeof block - used);
            std::memcpy(block + used, data, take); used += take; data += take; size -= take;
            if (used == sizeof block) { compress(block); used = 0; }
        }
    }
    std::string hex() {
        uint64_t bits = length * 8;
        unsigned char pad = 0x80; update(&pad, 1);
        unsigned char zero = 0; while (used != 56) update(&zero, 1);
        unsigned char tail[8]; for (int i = 0; i < 8; ++i) tail[7 - i] = static_cast<unsigned char>(bits >> (8 * i));
        update(tail, 8);
        static const char *digits = "0123456789abcdef";
        std::string out;
        for (uint32_t word : h) for (int i = 3; i >= 0; --i) { unsigned char b = static_cast<unsigned char>(word >> (8 * i)); out += digits[b >> 4]; out += digits[b & 15]; }
        return out;
    }
private:
    static uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
    void compress(const unsigned char *p) {
        static const uint32_t k[64] = {
            0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
            0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
            0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
            0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
        uint32_t w[64];
        for (int i = 0; i < 16; ++i) w[i] = (uint32_t(p[4 * i]) << 24) | (uint32_t(p[4 * i + 1]) << 16) | (uint32_t(p[4 * i + 2]) << 8) | uint32_t(p[4 * i + 3]);
        for (int i = 16; i < 64; ++i) { uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10); w[i] = w[i - 16] + s0 + w[i - 7] + s1; }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (int i = 0; i < 64; ++i) {
            uint32_t t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i];
            uint32_t t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
            hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    uint32_t h[8]; unsigned char block[64]; size_t used; uint64_t length;
};

// ---------- JSON output ----------
bool validUtf8(const std::string &s) {
    size_t i = 0, n = s.size();
    while (i < n) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        if (c < 0x80) { ++i; continue; }
        int len = (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 0;
        if (!len || i + len > n) return false;
        uint32_t cp = c & (len == 2 ? 0x1F : len == 3 ? 0x0F : 0x07);
        for (int k = 1; k < len; ++k) { unsigned char d = static_cast<unsigned char>(s[i + k]); if ((d & 0xC0) != 0x80) return false; cp = (cp << 6) | (d & 0x3F); }
        if ((len == 2 && cp < 0x80) || (len == 3 && cp < 0x800) || (len == 4 && (cp < 0x10000 || cp > 0x10FFFF)) || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
        i += len;
    }
    return true;
}
std::string quote(const std::string &s) {
    std::string out = "\"";
    for (unsigned char c : s) {
        if (c == '"') out += "\\\""; else if (c == '\\') out += "\\\\";
        else if (c < 0x20 || c == 0x7f) { char buf[8]; std::snprintf(buf, sizeof buf, "\\u%04x", c); out += buf; }
        else out += static_cast<char>(c);
    }
    return out + "\"";
}
std::string base64(const unsigned char *data, size_t size) {
    static const char *table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out; out.reserve((size + 2) / 3 * 4);
    for (size_t i = 0; i < size; i += 3) {
        uint32_t v = uint32_t(data[i]) << 16 | (i + 1 < size ? uint32_t(data[i + 1]) << 8 : 0) | (i + 2 < size ? data[i + 2] : 0);
        out += table[(v >> 18) & 63]; out += table[(v >> 12) & 63];
        out += i + 1 < size ? table[(v >> 6) & 63] : '='; out += i + 2 < size ? table[v & 63] : '=';
    }
    return out;
}
std::string decodeBase64(const std::string &text) {
    std::string out; uint32_t buffer = 0; int bits = 0;
    for (char ch : text) {
        int v = ch >= 'A' && ch <= 'Z' ? ch - 'A' : ch >= 'a' && ch <= 'z' ? ch - 'a' + 26 : ch >= '0' && ch <= '9' ? ch - '0' + 52 : ch == '+' ? 62 : ch == '/' ? 63 : ch == '=' ? -2 : -1;
        if (v == -2) break;
        if (v < 0) fail("usage", "Invalid base64 argument");
        buffer = (buffer << 6) | uint32_t(v); bits += 6;
        if (bits >= 8) { bits -= 8; out += static_cast<char>((buffer >> bits) & 0xFF); }
    }
    return out;
}
/** A name as JSON: text when it is valid UTF-8, otherwise its bytes in base64 and a flag. */
std::string nameField(const char *key, const std::string &name) {
    if (validUtf8(name)) return quote(key) + ":" + quote(name);
    return quote(key) + ":\"\"," + quote(std::string(key) + "B64") + ":" + quote(base64(reinterpret_cast<const unsigned char *>(name.data()), name.size())) + ",\"invalidName\":true";
}

// ---------- resolution ----------
long openat2Call(int dirfd, const char *path, uint64_t flags, mode_t mode) {
    struct open_how how{}; how.flags = flags | O_CLOEXEC; how.mode = mode;
    how.resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS;
    return syscall(SYS_openat2, dirfd, path, &how, sizeof how);
}
[[noreturn]] void failErrno(int error, const std::string &what) {
    switch (error) {
        case ENOENT: fail("missing", what + " does not exist");
        case ELOOP: fail("symlink", what + " is or passes through a symbolic link, which Cere does not follow");
        case EXDEV: fail("escape", what + " is outside the allowed folder");
        case ENOTDIR: fail("not-directory", what + " is not inside a folder");
        case EISDIR: fail("is-directory", what + " is a folder");
        case EACCES: case EPERM: fail("denied", "Permission denied for " + what);
        case EEXIST: case ENOTEMPTY: fail("exists", what + " already exists");
        case ENOSYS: fail("unsupported", "This kernel lacks openat2; Cere cannot confine file access safely here");
        case ENOSPC: case EDQUOT: fail("no-space", "No space left for " + what);
        case EROFS: fail("read-only", what + " is on a read-only filesystem");
        case ENAMETOOLONG: fail("name-too-long", what + " has a name that is too long");
        default: fail("io", what + ": " + std::strerror(error));
    }
}
void checkRelative(const std::string &rel) {
    if (rel.size() > 4096) fail("name-too-long", "The path is longer than 4096 characters");
    if (!rel.empty() && rel[0] == '/') fail("escape", "Absolute paths are not accepted");
    size_t start = 0;
    while (start <= rel.size()) {
        size_t end = rel.find('/', start); if (end == std::string::npos) end = rel.size();
        std::string part = rel.substr(start, end - start);
        if (part == "..") fail("escape", "Paths cannot contain ..");
        for (unsigned char c : part) if (c < 0x20 || c == 0x7f) fail("invalid-name", "Paths cannot contain control characters");
        start = end + 1;
    }
}
struct Root { Fd fd; dev_t dev; ino_t ino; };
Root openRoot(const std::string &path, const std::string &dev, const std::string &ino) {
    int raw = ::open(path.c_str(), O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (raw < 0) { int e = errno; if (e == ENOENT) fail("root-missing", "The folder is no longer available (was a drive removed?)"); failErrno(e, "The folder"); }
    Root root{Fd(raw), 0, 0};
    struct stat st{}; if (fstat(raw, &st) != 0) failErrno(errno, "The folder");
    if (std::to_string(static_cast<unsigned long long>(st.st_dev)) != dev || std::to_string(static_cast<unsigned long long>(st.st_ino)) != ino)
        fail("root-changed", "The folder at this location was replaced since it was chosen. Choose it again.");
    root.dev = st.st_dev; root.ino = st.st_ino;
    return root;
}
Fd beneath(const Root &root, const std::string &rel, uint64_t flags, const std::string &what) {
    checkRelative(rel);
    long fd = openat2Call(root.fd.get(), rel.empty() ? "." : rel.c_str(), flags, 0);
    if (fd < 0) failErrno(errno, what);
    return Fd(static_cast<int>(fd));
}
struct Parent { Fd dir; std::string base; };
Parent parentOf(const Root &root, const std::string &rel, const std::string &what) {
    checkRelative(rel);
    size_t slash = rel.find_last_of('/');
    std::string dir = slash == std::string::npos ? "" : rel.substr(0, slash), base = slash == std::string::npos ? rel : rel.substr(slash + 1);
    if (base.empty() || base == "." || base == "..") fail("invalid-name", "Choose a file or folder name");
    return Parent{beneath(root, dir, O_PATH | O_DIRECTORY, "The containing folder of " + what), base};
}
const char *typeName(mode_t mode) {
    return S_ISREG(mode) ? "file" : S_ISDIR(mode) ? "directory" : S_ISLNK(mode) ? "symlink" : S_ISFIFO(mode) ? "fifo" : S_ISSOCK(mode) ? "socket" : S_ISCHR(mode) || S_ISBLK(mode) ? "device" : "other";
}
/** Reopens an O_PATH descriptor of a regular file for reading without resolving any path again. */
Fd reopenRegular(Fd pathFd, const struct stat &expected, const std::string &what) {
    char proc[64]; std::snprintf(proc, sizeof proc, "/proc/self/fd/%d", pathFd.get());
    int raw = ::open(proc, O_RDONLY | O_CLOEXEC | O_NOCTTY | O_NONBLOCK);
    if (raw < 0) failErrno(errno, what);
    Fd fd(raw); struct stat st{};
    if (fstat(raw, &st) != 0) failErrno(errno, what);
    if (!S_ISREG(st.st_mode) || st.st_ino != expected.st_ino || st.st_dev != expected.st_dev) fail("changed", what + " changed while it was being opened");
    int flags = fcntl(raw, F_GETFL); if (flags >= 0) fcntl(raw, F_SETFL, flags & ~O_NONBLOCK);
    return fd;
}
Fd openRegular(const Root &root, const std::string &rel, struct stat &st, const std::string &what) {
    Fd path = beneath(root, rel, O_PATH, what);
    if (fstat(path.get(), &st) != 0) failErrno(errno, what);
    if (S_ISDIR(st.st_mode)) fail("is-directory", what + " is a folder");
    if (!S_ISREG(st.st_mode)) fail("special-file", what + " is not a regular file (" + typeName(st.st_mode) + "); Cere does not read it");
    return reopenRegular(std::move(path), st, what);
}
Fd openRegularAt(int dirfd, const std::string &name, struct stat &st, const std::string &what) {
    int raw = ::openat(dirfd, name.c_str(), O_PATH | O_NOFOLLOW | O_CLOEXEC);
    if (raw < 0) failErrno(errno, what);
    Fd path(raw);
    if (fstat(raw, &st) != 0) failErrno(errno, what);
    if (S_ISLNK(st.st_mode)) fail("symlink", what + " is a symbolic link, which Cere does not follow");
    if (S_ISDIR(st.st_mode)) fail("is-directory", what + " is a folder");
    if (!S_ISREG(st.st_mode)) fail("special-file", what + " is not a regular file");
    return reopenRegular(std::move(path), st, what);
}
/** Reads at most limit bytes; *grew is set when the file holds more. The hash covers exactly the bytes read. */
std::string readAll(int fd, size_t limit, Sha256 *hash, bool *grew = nullptr) {
    std::string out; unsigned char buffer[1 << 16];
    for (;;) {
        ssize_t n = ::read(fd, buffer, sizeof buffer);
        if (n < 0) { if (errno == EINTR) continue; failErrno(errno, "Reading the file"); }
        if (n == 0) break;
        size_t take = std::min(static_cast<size_t>(n), limit - out.size());
        if (hash) hash->update(buffer, take);
        out.append(reinterpret_cast<char *>(buffer), take);
        if (take < static_cast<size_t>(n) || out.size() == limit) {
            if (take < static_cast<size_t>(n)) { if (grew) *grew = true; break; }
            unsigned char probe; ssize_t more;
            do more = ::read(fd, &probe, 1); while (more < 0 && errno == EINTR);
            if (more > 0 && grew) *grew = true;
            break;
        }
    }
    return out;
}
constexpr size_t hashLimit = size_t(1) << 30;
std::string hashFd(int fd) { Sha256 hash; bool grew = false; readAll(fd, hashLimit, &hash, &grew); if (grew) fail("too-large", "The file is too large to verify"); return hash.hex(); }
long long millis(const struct timespec &t) { return static_cast<long long>(t.tv_sec) * 1000 + t.tv_nsec / 1000000; }
std::string statJson(const struct stat &st) {
    return std::string("\"type\":") + quote(typeName(st.st_mode)) + ",\"size\":" + std::to_string(static_cast<long long>(st.st_size)) +
        ",\"mtimeMs\":" + std::to_string(millis(st.st_mtim)) + ",\"mode\":" + std::to_string(st.st_mode & 07777) + ",\"nlink\":" + std::to_string(static_cast<unsigned long long>(st.st_nlink)) +
        ",\"dev\":\"" + std::to_string(static_cast<unsigned long long>(st.st_dev)) + "\",\"ino\":\"" + std::to_string(static_cast<unsigned long long>(st.st_ino)) + "\"";
}
std::string randomSuffix() {
    unsigned char bytes[6]{};
    if (getrandom(bytes, sizeof bytes, 0) != static_cast<ssize_t>(sizeof bytes)) fail("io", "No randomness for a temporary name");
    static const char *digits = "0123456789abcdef"; std::string out;
    for (unsigned char b : bytes) { out += digits[b >> 4]; out += digits[b & 15]; }
    return out;
}
void writeAllFd(int fd, const char *data, size_t size) {
    while (size) {
        ssize_t n = ::write(fd, data, size);
        if (n < 0) { if (errno == EINTR) continue; failErrno(errno, "Writing the file"); }
        data += n; size -= static_cast<size_t>(n);
    }
}
/** A temporary file next to the destination, created exclusively and never following links. */
struct Temporary { int dir; std::string name; Fd fd; bool keep = false; ~Temporary() { if (!keep && !name.empty()) ::unlinkat(dir, name.c_str(), 0); } };
std::unique_ptr<Temporary> temporaryIn(int dirfd, const std::string &base) {
    auto temp = std::make_unique<Temporary>(); temp->dir = dirfd;
    std::string stem = base.substr(0, 40);
    for (int attempt = 0; attempt < 8; ++attempt) {
        std::string name = "." + stem + ".cere-" + randomSuffix();
        int raw = ::openat(dirfd, name.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (raw >= 0) { temp->name = name; temp->fd = Fd(raw); return temp; }
        if (errno != EEXIST) failErrno(errno, "A temporary file");
    }
    fail("io", "Could not create a temporary file");
}
/** Moves a finished temporary file to a name that must not exist yet, without ever overwriting. */
void placeNew(Temporary &temp, int dirfd, const std::string &base) {
    if (syscall(SYS_renameat2, temp.dir, temp.name.c_str(), dirfd, base.c_str(), RENAME_NOREPLACE) == 0) { temp.keep = true; return; }
    int error = errno;
    if (error == EEXIST) fail("exists", base + " already exists; nothing was overwritten");
    if (error != EINVAL && error != ENOSYS) failErrno(error, base);
    // Filesystems without RENAME_NOREPLACE: link(2) also refuses an existing name.
    if (::linkat(temp.dir, temp.name.c_str(), dirfd, base.c_str(), 0) != 0) { int e = errno; if (e == EEXIST) fail("exists", base + " already exists; nothing was overwritten"); failErrno(e, base); }
}
/** Checks a precondition on an existing name: "absent", "any", "sha256:HEX" (regular file) or "ino:N". */
void checkExpectation(int dirfd, const std::string &base, const std::string &expect, const std::string &what) {
    if (expect == "any") return;
    struct stat st{};
    int found = ::fstatat(dirfd, base.c_str(), &st, AT_SYMLINK_NOFOLLOW);
    if (expect == "absent") {
        if (found == 0) fail("exists", what + " already exists");
        if (errno != ENOENT) failErrno(errno, what);
        return;
    }
    if (found != 0) { if (errno == ENOENT) fail("stale", what + " no longer exists"); failErrno(errno, what); }
    if (expect.rfind("ino:", 0) == 0) { if (std::to_string(static_cast<unsigned long long>(st.st_ino)) != expect.substr(4)) fail("stale", what + " was replaced"); return; }
    if (expect.rfind("sha256:", 0) != 0) fail("usage", "Unknown expectation");
    struct stat opened{}; Fd fd = openRegularAt(dirfd, base, opened, what);
    if (hashFd(fd.get()) != expect.substr(7)) fail("stale", what + " changed since it was reviewed; nothing was changed");
}

// ---------- operations ----------
struct Args {
    std::vector<std::string> positional; bool hidden = false, icase = false;
    long long maxEntries = 500, maxDepth = 16, deadlineMs = 10000, maxFileBytes = 2 << 20, maxMatches = 50, maxBytes = 64 << 20, limit = 100;
    std::vector<std::string> excludes, denies, excludePaths; std::string after, expect = "any", glob;
};
Args parse(int argc, char **argv, int start) {
    Args a;
    for (int i = start; i < argc; ++i) {
        std::string s = argv[i];
        auto value = [&](const char *flag) -> std::string { if (i + 1 >= argc) fail("usage", std::string("Missing value for ") + flag); return argv[++i]; };
        auto number = [&](const char *flag) -> long long { std::string v = value(flag); char *end = nullptr; long long n = std::strtoll(v.c_str(), &end, 10); if (!end || *end || n < 0) fail("usage", std::string("Invalid number for ") + flag); return n; };
        if (s == "--hidden") a.hidden = true; else if (s == "--icase") a.icase = true;
        else if (s == "--max-entries") a.maxEntries = number("--max-entries"); else if (s == "--max-depth") a.maxDepth = number("--max-depth");
        else if (s == "--deadline-ms") a.deadlineMs = number("--deadline-ms"); else if (s == "--max-file-bytes") a.maxFileBytes = number("--max-file-bytes");
        else if (s == "--max-matches") a.maxMatches = number("--max-matches"); else if (s == "--max-bytes") a.maxBytes = number("--max-bytes");
        else if (s == "--limit") a.limit = number("--limit"); else if (s == "--exclude") a.excludes.push_back(value("--exclude"));
        else if (s == "--deny") a.denies.push_back(value("--deny")); else if (s == "--after") a.after = decodeBase64(value("--after"));
        else if (s == "--expect") a.expect = value("--expect"); else if (s == "--glob") a.glob = decodeBase64(value("--glob"));
        else if (s == "--exclude-path") a.excludePaths.push_back(decodeBase64(value("--exclude-path")));
        else if (s.rfind("--", 0) == 0) fail("usage", "Unknown option " + s);
        else a.positional.push_back(s);
    }
    return a;
}
void need(const Args &a, size_t count) { if (a.positional.size() != count) fail("usage", "Wrong number of arguments"); }
std::string relArg(const std::string &value) { return value == "." ? "" : value; }

std::string opStat(const Args &a) {
    need(a, 4); Root root = openRoot(a.positional[0], a.positional[1], a.positional[2]);
    std::string rel = relArg(a.positional[3]);
    Fd path = beneath(root, rel, O_PATH, "The item");
    struct stat st{}; if (fstat(path.get(), &st) != 0) failErrno(errno, "The item");
    std::string out = "{\"ok\":true," + statJson(st);
    if (S_ISREG(st.st_mode) && st.st_size <= a.maxBytes) { Fd fd = reopenRegular(std::move(path), st, "The file"); out += ",\"sha256\":" + quote(hashFd(fd.get())); }
    return out + "}";
}

std::string opList(const Args &a) {
    need(a, 4); Root root = openRoot(a.positional[0], a.positional[1], a.positional[2]);
    Fd dir = beneath(root, relArg(a.positional[3]), O_RDONLY | O_DIRECTORY, "The folder");
    int raw = ::dup(dir.get()); if (raw < 0) failErrno(errno, "The folder");
    DIR *stream = ::fdopendir(raw); if (!stream) { ::close(raw); failErrno(errno, "The folder"); }
    struct Entry { std::string name; struct stat st; bool statOk; };
    std::vector<Entry> entries; long long hiddenCount = 0, total = 0;
    errno = 0;
    while (struct dirent *item = ::readdir(stream)) {
        std::string name = item->d_name;
        if (name == "." || name == "..") continue;
        ++total;
        if (!a.hidden && name[0] == '.') { ++hiddenCount; continue; }
        struct stat st{};
        bool statOk = ::fstatat(dir.get(), name.c_str(), &st, AT_SYMLINK_NOFOLLOW) == 0;
        entries.push_back(Entry{name, st, statOk});
        if (entries.size() > 100000) break;
    }
    ::closedir(stream);
    std::sort(entries.begin(), entries.end(), [](const Entry &x, const Entry &y) { return x.name < y.name; });
    std::string out = "{\"ok\":true,\"entries\":[";
    long long emitted = 0; std::string last; bool more = false;
    for (const Entry &entry : entries) {
        if (!a.after.empty() && entry.name <= a.after) continue;
        if (emitted >= a.limit) { more = true; break; }
        if (emitted) out += ",";
        out += "{" + nameField("name", entry.name) + ",";
        out += entry.statOk ? statJson(entry.st) : std::string("\"type\":\"unavailable\"");
        out += "}"; ++emitted; last = entry.name;
    }
    out += "],\"hidden\":" + std::to_string(hiddenCount) + ",\"total\":" + std::to_string(total);
    if (more) out += ",\"next\":" + quote(base64(reinterpret_cast<const unsigned char *>(last.data()), last.size()));
    return out + "}";
}

std::string opRead(const Args &a) {
    need(a, 4); Root root = openRoot(a.positional[0], a.positional[1], a.positional[2]);
    struct stat st{}; Fd fd = openRegular(root, relArg(a.positional[3]), st, "The file");
    if (st.st_size > a.maxBytes) fail("too-large", "The file is larger than Cere reads (" + std::to_string(static_cast<long long>(st.st_size)) + " bytes)");
    Sha256 hash; bool grew = false; std::string data = readAll(fd.get(), static_cast<size_t>(a.maxBytes), &hash, &grew);
    if (grew) fail("changed", "The file grew while it was being read; try again");
    return "{\"ok\":true," + statJson(st) + ",\"sha256\":" + quote(hash.hex()) + ",\"data\":" + quote(base64(reinterpret_cast<const unsigned char *>(data.data()), data.size())) + "}";
}

std::string readStdin(size_t limit) {
    std::string out; char buffer[1 << 16];
    for (;;) {
        ssize_t n = ::read(0, buffer, sizeof buffer);
        if (n < 0) { if (errno == EINTR) continue; failErrno(errno, "Reading staged content"); }
        if (n == 0) break;
        out.append(buffer, static_cast<size_t>(n));
        if (out.size() > limit) fail("too-large", "The staged content is larger than allowed");
    }
    return out;
}

// write ROOT DEV INO REL MODE --expect absent|sha256:HEX ; content on stdin
std::string opWrite(const Args &a) {
    need(a, 5); Root root = openRoot(a.positional[0], a.positional[1], a.positional[2]);
    std::string rel = relArg(a.positional[3]);
    char *end = nullptr; long mode = std::strtol(a.positional[4].c_str(), &end, 8); if (!end || *end || mode < 0 || mode > 0777) fail("usage", "Invalid mode");
    if (a.expect == "any") fail("usage", "A write needs an expectation");
    std::string data = readStdin(static_cast<size_t>(a.maxBytes));
    Parent parent = parentOf(root, rel, "the file");
    checkExpectation(parent.dir.get(), parent.base, a.expect, parent.base);
    auto temp = temporaryIn(parent.dir.get(), parent.base);
    writeAllFd(temp->fd.get(), data.data(), data.size());
    if (::fchmod(temp->fd.get(), static_cast<mode_t>(mode)) != 0) failErrno(errno, "The new file");
    if (::fsync(temp->fd.get()) != 0) failErrno(errno, "The new file");
    temp->fd.reset();
    Sha256 hash; hash.update(reinterpret_cast<const unsigned char *>(data.data()), data.size());
    std::string digest = hash.hex();
    if (a.expect == "absent") placeNew(*temp, parent.dir.get(), parent.base);
    else {
        // The last check before replacement; an external editor can still race the rename itself.
        checkExpectation(parent.dir.get(), parent.base, a.expect, parent.base);
        if (::renameat(temp->dir, temp->name.c_str(), parent.dir.get(), parent.base.c_str()) != 0) failErrno(errno, parent.base);
        temp->keep = true;
    }
    ::fsync(parent.dir.get());
    return "{\"ok\":true,\"sha256\":" + quote(digest) + ",\"size\":" + std::to_string(data.size()) + "}";
}

// mkdir ROOT DEV INO REL
std::string opMkdir(const Args &a) {
    need(a, 4); Root root = openRoot(a.positional[0], a.positional[1], a.positional[2]);
    Parent parent = parentOf(root, relArg(a.positional[3]), "the folder");
    if (::mkdirat(parent.dir.get(), parent.base.c_str(), 0777) != 0) failErrno(errno, parent.base);
    struct stat st{}; ::fstatat(parent.dir.get(), parent.base.c_str(), &st, AT_SYMLINK_NOFOLLOW);
    return "{\"ok\":true," + statJson(st) + "}";
}

// copy SROOT SDEV SINO SREL DROOT DDEV DINO DREL --expect sha256:HEX|any
std::string opCopy(const Args &a) {
    need(a, 8);
    Root source = openRoot(a.positional[0], a.positional[1], a.positional[2]), target = openRoot(a.positional[4], a.positional[5], a.positional[6]);
    struct stat st{}; Fd input = openRegular(source, relArg(a.positional[3]), st, "The source file");
    if (st.st_size > a.maxBytes) fail("too-large", "The file is larger than Cere copies in one operation");
    Parent parent = parentOf(target, relArg(a.positional[7]), "the destination");
    checkExpectation(parent.dir.get(), parent.base, "absent", parent.base);
    auto temp = temporaryIn(parent.dir.get(), parent.base);
    Sha256 hash; unsigned char buffer[1 << 16]; long long copied = 0;
    for (;;) {
        ssize_t n = ::read(input.get(), buffer, sizeof buffer);
        if (n < 0) { if (errno == EINTR) continue; failErrno(errno, "Reading the source"); }
        if (n == 0) break;
        hash.update(buffer, static_cast<size_t>(n)); writeAllFd(temp->fd.get(), reinterpret_cast<char *>(buffer), static_cast<size_t>(n));
        copied += n; if (copied > a.maxBytes) fail("too-large", "The file grew beyond the copy limit");
    }
    std::string digest = hash.hex();
    if (a.expect != "any" && a.expect != "sha256:" + digest) fail("stale", "The source changed since it was reviewed; nothing was copied");
    if (::fchmod(temp->fd.get(), st.st_mode & 0777) != 0) failErrno(errno, "The copy");
    if (::fsync(temp->fd.get()) != 0) failErrno(errno, "The copy");
    temp->fd.reset();
    placeNew(*temp, parent.dir.get(), parent.base);
    ::fsync(parent.dir.get());
    return "{\"ok\":true,\"sha256\":" + quote(digest) + ",\"size\":" + std::to_string(copied) + "}";
}

// rename SROOT SDEV SINO SREL DROOT DDEV DINO DREL --expect sha256:HEX|ino:N|any
std::string opRename(const Args &a) {
    need(a, 8);
    Root source = openRoot(a.positional[0], a.positional[1], a.positional[2]), target = openRoot(a.positional[4], a.positional[5], a.positional[6]);
    Parent from = parentOf(source, relArg(a.positional[3]), "the source"), to = parentOf(target, relArg(a.positional[7]), "the destination");
    struct stat st{};
    if (::fstatat(from.dir.get(), from.base.c_str(), &st, AT_SYMLINK_NOFOLLOW) != 0) { if (errno == ENOENT) fail("stale", from.base + " no longer exists"); failErrno(errno, from.base); }
    if (!S_ISREG(st.st_mode) && !S_ISDIR(st.st_mode)) fail("special-file", from.base + " is not a regular file or folder");
    checkExpectation(from.dir.get(), from.base, a.expect, from.base);
    if (syscall(SYS_renameat2, from.dir.get(), from.base.c_str(), to.dir.get(), to.base.c_str(), RENAME_NOREPLACE) != 0) {
        int error = errno;
        if (error == EXDEV) fail("cross-device", "The destination is on another filesystem; this needs a copy and removal");
        if (error == EEXIST) fail("exists", to.base + " already exists; nothing was moved");
        if (error == EINVAL && S_ISREG(st.st_mode)) {
            if (::linkat(from.dir.get(), from.base.c_str(), to.dir.get(), to.base.c_str(), 0) != 0) { int e = errno; if (e == EEXIST) fail("exists", to.base + " already exists; nothing was moved"); failErrno(e, to.base); }
            if (::unlinkat(from.dir.get(), from.base.c_str(), 0) != 0) failErrno(errno, from.base);
        } else failErrno(error, to.base);
    }
    ::fsync(from.dir.get()); ::fsync(to.dir.get());
    return "{\"ok\":true," + statJson(st) + "}";
}

// unlink ROOT DEV INO REL --expect sha256:HEX ; rmdir ROOT DEV INO REL --expect ino:N
std::string opRemove(const Args &a, bool directory) {
    need(a, 4); Root root = openRoot(a.positional[0], a.positional[1], a.positional[2]);
    if (a.expect == "any" || a.expect == "absent") fail("usage", "Removal needs an expectation");
    Parent parent = parentOf(root, relArg(a.positional[3]), "the item");
    struct stat st{};
    if (::fstatat(parent.dir.get(), parent.base.c_str(), &st, AT_SYMLINK_NOFOLLOW) != 0) { if (errno == ENOENT) fail("stale", parent.base + " no longer exists"); failErrno(errno, parent.base); }
    if (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) fail("stale", parent.base + " is no longer the reviewed kind of item");
    checkExpectation(parent.dir.get(), parent.base, a.expect, parent.base);
    if (::unlinkat(parent.dir.get(), parent.base.c_str(), directory ? AT_REMOVEDIR : 0) != 0) failErrno(errno, parent.base);
    ::fsync(parent.dir.get());
    return "{\"ok\":true}";
}

// ---------- walking and searching ----------
using Clock = std::chrono::steady_clock;
/** Orders paths component by component, ancestors first: the order of a sorted depth-first walk. */
int componentCompare(const std::string &x, const std::string &y) {
    size_t i = 0, j = 0;
    for (;;) {
        size_t xe = x.find('/', i), ye = y.find('/', j);
        std::string xs = x.substr(i, xe == std::string::npos ? std::string::npos : xe - i), ys = y.substr(j, ye == std::string::npos ? std::string::npos : ye - j);
        if (xs != ys) return xs < ys ? -1 : 1;
        bool xEnd = xe == std::string::npos, yEnd = ye == std::string::npos;
        if (xEnd || yEnd) return xEnd && yEnd ? 0 : xEnd ? -1 : 1;
        i = xe + 1; j = ye + 1;
    }
}
struct Walk {
    const Args &args; Clock::time_point deadline; long long visited = 0; std::string stop;
    explicit Walk(const Args &a) : args(a), deadline(Clock::now() + std::chrono::milliseconds(a.deadlineMs)) {}
    bool excluded(const std::string &name, bool dir) const {
        if (!args.hidden && name[0] == '.') return true;
        if (dir) for (const std::string &x : args.excludes) if (x == name) return true;
        if (!dir) for (const std::string &x : args.denies) {
            if (!x.empty() && x[0] == '*') { std::string tail = x.substr(1); if (name.size() >= tail.size() && name.compare(name.size() - tail.size(), tail.size(), tail) == 0) return true; }
            else if (!x.empty() && x.back() == '*') { if (name.rfind(x.substr(0, x.size() - 1), 0) == 0) return true; }
            else if (x == name) return true;
        }
        return false;
    }
    bool expired() { if (Clock::now() > deadline) { stop = "deadline"; return true; } return false; }
};
bool containsCase(const std::string &hay, const std::string &needle, bool icase) {
    if (!icase) return hay.find(needle) != std::string::npos;
    auto lower = [](unsigned char c) { return static_cast<unsigned char>(c >= 'A' && c <= 'Z' ? c + 32 : c); };
    return std::search(hay.begin(), hay.end(), needle.begin(), needle.end(), [&](char x, char y) { return lower(static_cast<unsigned char>(x)) == lower(static_cast<unsigned char>(y)); }) != hay.end();
}
template <typename Visit>
void walkDir(Walk &walk, int dirfd, const std::string &prefix, int depth, Visit &&visit) {
    if (!walk.stop.empty()) return;
    if (depth > walk.args.maxDepth) { walk.stop = "depth"; return; }
    int raw = ::dup(dirfd); if (raw < 0) return;
    DIR *stream = ::fdopendir(raw); if (!stream) { ::close(raw); return; }
    std::vector<std::string> names;
    while (struct dirent *item = ::readdir(stream)) { std::string name = item->d_name; if (name != "." && name != "..") names.push_back(name); }
    ::closedir(stream);
    std::sort(names.begin(), names.end());
    const std::string &after = walk.args.after;
    for (const std::string &name : names) {
        if (!walk.stop.empty() || walk.expired()) return;
        struct stat st{};
        if (::fstatat(dirfd, name.c_str(), &st, AT_SYMLINK_NOFOLLOW) != 0) continue;
        std::string path = prefix.empty() ? name : prefix + "/" + name;
        bool dir = S_ISDIR(st.st_mode);
        if (walk.excluded(name, dir) || std::find(walk.args.excludePaths.begin(), walk.args.excludePaths.end(), path) != walk.args.excludePaths.end()) continue;
        // A cursor resumes after the last path the previous page finished, in the walk's own order.
        int order = after.empty() ? 1 : componentCompare(path, after);
        bool holdsCursor = dir && !after.empty() && (order == 0 || after.rfind(path + "/", 0) == 0);
        if (order <= 0 && !holdsCursor) continue;
        if (order > 0) {
            if (++walk.visited > walk.args.maxEntries) { walk.stop = "entries"; return; }
            visit(path, name, st, dirfd);
        }
        if (dir && walk.stop.empty()) {
            int child = ::openat(dirfd, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            if (child < 0) continue;
            Fd guard(child);
            walkDir(walk, child, path, depth + 1, visit);
        }
    }
}

// walk ROOT DEV INO REL [--glob B64 --icase] [--hidden] [--exclude N]... [--max-entries N] [--max-depth D] [--deadline-ms T] [--limit N] [--after B64]
std::string opWalk(const Args &a) {
    need(a, 4); Root root = openRoot(a.positional[0], a.positional[1], a.positional[2]);
    std::string base = relArg(a.positional[3]);
    Fd dir = beneath(root, base, O_RDONLY | O_DIRECTORY, "The folder");
    Walk walk(a); std::string out = "{\"ok\":true,\"entries\":["; long long emitted = 0; std::string last; bool more = false;
    walkDir(walk, dir.get(), "", 0, [&](const std::string &path, const std::string &name, const struct stat &st, int) {
        if (!a.glob.empty() && ::fnmatch(a.glob.c_str(), name.c_str(), FNM_PERIOD | (a.icase ? FNM_CASEFOLD : 0)) != 0) return;
        if (emitted >= a.limit) { more = true; walk.stop = "limit"; return; }
        if (emitted++) out += ",";
        out += "{" + nameField("path", path) + "," + statJson(st) + "}"; last = path;
    });
    out += "],\"visited\":" + std::to_string(walk.visited) + ",\"stopped\":" + quote(walk.stop);
    if (more || (!walk.stop.empty() && !last.empty())) out += ",\"next\":" + quote(base64(reinterpret_cast<const unsigned char *>(last.data()), last.size()));
    return out + "}";
}

// search ROOT DEV INO REL QUERY_B64 [--icase] [--hidden] [--exclude N]... [--deny P]... [--max-entries] [--max-depth] [--deadline-ms] [--max-file-bytes] [--max-matches] [--after B64]
std::string opSearch(const Args &a) {
    need(a, 5); Root root = openRoot(a.positional[0], a.positional[1], a.positional[2]);
    std::string query = decodeBase64(a.positional[4]);
    if (query.empty() || query.size() > 1000) fail("usage", "Search for 1 to 1000 characters");
    Fd dir = beneath(root, relArg(a.positional[3]), O_RDONLY | O_DIRECTORY, "The folder");
    Walk walk(a); std::string out = "{\"ok\":true,\"files\":["; long long matches = 0, filesEmitted = 0, searched = 0, skippedLarge = 0, skippedBinary = 0;
    std::string lastFinished; bool full = false;
    walkDir(walk, dir.get(), "", 0, [&](const std::string &path, const std::string &name, const struct stat &st, int parent) {
        if (!S_ISREG(st.st_mode)) return;
        if (st.st_size > a.maxFileBytes) { ++skippedLarge; return; }
        if (matches >= a.maxMatches) { full = true; walk.stop = "matches"; return; }
        struct stat opened{}; std::string content;
        try { Fd fd = openRegularAt(parent, name, opened, path); bool grew = false; content = readAll(fd.get(), static_cast<size_t>(a.maxFileBytes), nullptr, &grew); if (grew) return; }
        catch (const Failure &) { return; }
        ++searched;
        if (content.find('\0') != std::string::npos) { ++skippedBinary; return; }
        if (!containsCase(content, query, a.icase)) { lastFinished = path; return; }
        Sha256 hash; hash.update(reinterpret_cast<const unsigned char *>(content.data()), content.size());
        std::string lines; long long lineNo = 0; size_t start = 0, count = 0;
        while (start <= content.size() && matches < a.maxMatches) {
            size_t end = content.find('\n', start); if (end == std::string::npos) end = content.size();
            ++lineNo;
            std::string line = content.substr(start, end - start);
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (containsCase(line, query, a.icase)) {
                std::string shown = line.substr(0, 400);
                while (!shown.empty() && !validUtf8(shown)) shown.pop_back();
                if (count++) lines += ",";
                lines += "{\"line\":" + std::to_string(lineNo) + ",\"text\":" + quote(shown) + (line.size() > 400 ? ",\"clipped\":true" : "") + "}";
                ++matches;
            }
            if (end == content.size()) break;
            start = end + 1;
        }
        if (filesEmitted++) out += ",";
        out += "{" + nameField("path", path) + ",\"sha256\":" + quote(hash.hex()) + ",\"size\":" + std::to_string(static_cast<long long>(st.st_size)) + ",\"matches\":[" + lines + "]}";
        if (matches < a.maxMatches) lastFinished = path; else { full = true; walk.stop = "matches"; lastFinished = path; }
    });
    out += "],\"searched\":" + std::to_string(searched) + ",\"visited\":" + std::to_string(walk.visited) + ",\"skippedLarge\":" + std::to_string(skippedLarge) +
        ",\"skippedBinary\":" + std::to_string(skippedBinary) + ",\"stopped\":" + quote(walk.stop);
    if ((full || !walk.stop.empty()) && !lastFinished.empty()) out += ",\"next\":" + quote(base64(reinterpret_cast<const unsigned char *>(lastFinished.data()), lastFinished.size()));
    return out + "}";
}

// hash ROOT DEV INO REL
std::string opHash(const Args &a) {
    need(a, 4); Root root = openRoot(a.positional[0], a.positional[1], a.positional[2]);
    struct stat st{}; Fd fd = openRegular(root, relArg(a.positional[3]), st, "The file");
    return "{\"ok\":true," + statJson(st) + ",\"sha256\":" + quote(hashFd(fd.get())) + "}";
}
// identity PATH : device and inode of a directory, opened without following links
std::string opIdentity(const Args &a) {
    need(a, 1);
    int raw = ::open(a.positional[0].c_str(), O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (raw < 0) failErrno(errno, "The folder");
    Fd fd(raw); struct stat st{}; if (fstat(raw, &st) != 0) failErrno(errno, "The folder");
    return "{\"ok\":true," + statJson(st) + "}";
}
// probe : reports whether confinement is available on this kernel
std::string opProbe() {
    long fd = openat2Call(AT_FDCWD, ".", O_PATH | O_DIRECTORY, 0);
    if (fd < 0) failErrno(errno, "Confinement probe");
    ::close(static_cast<int>(fd));
    return "{\"ok\":true,\"openat2\":true,\"version\":1}";
}

}  // namespace

int main(int argc, char **argv) {
    if (argc < 2) { std::fputs("usage: cere-workspacefs OP ARGS...\n", stderr); return 2; }
    std::string op = argv[1], out;
    try {
        Args args = parse(argc, argv, 2);
        if (op == "probe") out = opProbe();
        else if (op == "identity") out = opIdentity(args);
        else if (op == "stat") out = opStat(args);
        else if (op == "list") out = opList(args);
        else if (op == "read") out = opRead(args);
        else if (op == "hash") out = opHash(args);
        else if (op == "write") out = opWrite(args);
        else if (op == "mkdir") out = opMkdir(args);
        else if (op == "copy") out = opCopy(args);
        else if (op == "rename") out = opRename(args);
        else if (op == "unlink") out = opRemove(args, false);
        else if (op == "rmdir") out = opRemove(args, true);
        else if (op == "walk") out = opWalk(args);
        else if (op == "search") out = opSearch(args);
        else { std::fputs("unknown operation\n", stderr); return 2; }
    } catch (const Failure &failure) {
        out = "{\"ok\":false,\"code\":" + quote(failure.code) + ",\"message\":" + quote(failure.message) + "}";
    }
    out += "\n";
    try { writeAllFd(1, out.data(), out.size()); } catch (const Failure &) { return 3; }
    return 0;
}
