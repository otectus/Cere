#include <sys/socket.h>
#include <sys/un.h>
#include <poll.h>
#include <unistd.h>
#include <ctime>
#include <chrono>
#include <string>
#include <cstring>
#include <cstdlib>
#include <cerrno>

static std::string quote(const char* value){std::string result="\"";for(const unsigned char* p=reinterpret_cast<const unsigned char*>(value);*p;++p){if(*p=='"'||*p=='\\'){result+='\\';result+=*p;}else if(*p<32){const char* hex="0123456789abcdef";result+="\\u00";result+=hex[*p>>4];result+=hex[*p&15];}else result+=*p;}return result+'"';}
int main(int argc,char** argv){
  if(argc!=8)return 0;
  for(int i:{2,3,5}){char* end=nullptr;strtoull(argv[i],&end,10);if(!*argv[i]||*end)return 0;}
  if(strlen(argv[1])>36||strlen(argv[4])>4096)return 0;
  const char* runtime=getenv("XDG_RUNTIME_DIR");std::string path=runtime?std::string(runtime)+"/cere/telemetry.sock":"/tmp/cere-"+std::to_string(getuid())+"/telemetry.sock";
  sockaddr_un address{};address.sun_family=AF_UNIX;if(path.size()>=sizeof address.sun_path)return 0;strcpy(address.sun_path,path.c_str());
  int fd=socket(AF_UNIX,SOCK_STREAM|SOCK_NONBLOCK|SOCK_CLOEXEC,0);if(fd<0)return 0;
  const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(200);
  auto wait=[&](short event){auto remaining=std::chrono::duration_cast<std::chrono::milliseconds>(deadline-std::chrono::steady_clock::now()).count();if(remaining<=0)return false;pollfd p{fd,event,0};return poll(&p,1,static_cast<int>(remaining))>0&&!(p.revents&(POLLERR|POLLNVAL));};
  if(connect(fd,reinterpret_cast<sockaddr*>(&address),sizeof address)<0&&errno!=EINPROGRESS){close(fd);return 0;}
  if(!wait(POLLOUT)){close(fd);return 0;}int error=0;socklen_t length=sizeof error;getsockopt(fd,SOL_SOCKET,SO_ERROR,&error,&length);if(error){close(fd);return 0;}
  ucred peer{};length=sizeof peer;if(getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&peer,&length)||peer.uid!=getuid()){close(fd);return 0;}
  std::string policy;char buffer[1024];while(policy.find('\n')==std::string::npos&&policy.size()<1024){if(!wait(POLLIN)){close(fd);return 0;}auto n=read(fd,buffer,sizeof buffer);if(n<=0){close(fd);return 0;}policy.append(buffer,n);}
  if(policy.find("\"enabled\":true")==std::string::npos){close(fd);return 0;}
  time_t now=time(nullptr);tm utc{};gmtime_r(&now,&utc);char ts[32];strftime(ts,sizeof ts,"%Y-%m-%dT%H:%M:%SZ",&utc);
  std::string event="{\"v\":1,\"type\":\"command\",\"hook_version\":1,\"session\":"+quote(argv[1])+",\"seq\":"+argv[2]+",\"pid\":"+argv[3]+",\"cwd\":"+quote(argv[4])+",\"status\":"+argv[5]+",\"ts\":"+quote(ts);
  if(policy.find("\"commands\":true")!=std::string::npos&&strlen(argv[6])<=8192&&*argv[6])event+=",\"cmd\":"+quote(argv[6]);event+="}\n";
  if(event.size()<=16385){size_t offset=0;while(offset<event.size()&&wait(POLLOUT)){auto n=send(fd,event.data()+offset,event.size()-offset,MSG_NOSIGNAL);if(n<=0)break;offset+=n;}}
  close(fd);return 0;
}
