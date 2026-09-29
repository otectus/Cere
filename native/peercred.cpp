#include <node_api.h>
#include <sys/socket.h>
#include <unistd.h>
#include <utility>
#include <initializer_list>

static napi_value credentials(napi_env env, napi_callback_info info) {
    size_t count = 1;
    napi_value argument, result;
    int32_t fd;
    napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr);
    if (count != 1 || napi_get_value_int32(env, argument, &fd) != napi_ok || fd < 0) {
        napi_throw_type_error(env, nullptr, "Expected a connected socket descriptor");
        return nullptr;
    }
    struct ucred peer {};
    socklen_t length = sizeof(peer);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &length) || length != sizeof(peer)) {
        napi_throw_error(env, nullptr, "Cannot verify Unix peer credentials");
        return nullptr;
    }
    napi_create_object(env, &result);
    for (const auto& field : {std::pair{"uid", peer.uid}, std::pair{"gid", peer.gid}, std::pair{"pid", static_cast<unsigned>(peer.pid)}}) {
        napi_value value;
        napi_create_uint32(env, field.second, &value);
        napi_set_named_property(env, result, field.first, value);
    }
    return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
    napi_value function;
    napi_create_function(env, "credentials", NAPI_AUTO_LENGTH, credentials, nullptr, &function);
    napi_set_named_property(env, exports, "credentials", function);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
