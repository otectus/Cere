#include <node_api.h>
#include <uv.h>
#include <sys/inotify.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <string>
#include <mutex>
#include <unordered_map>

// Linux-only, worker-local handles. No telemetry text is printed or persisted here.
struct Watch { uv_poll_t poll; napi_env env; napi_ref callback; int fd; bool closed=false; };
static void cleanup(void* data);
struct Lock { napi_env env; int fd; };
static std::mutex locksMutex;
static std::unordered_map<int,Lock*> locks;
static void cleanupLock(void* data){auto* lock=static_cast<Lock*>(data);{std::lock_guard<std::mutex> guard(locksMutex);locks.erase(lock->fd);}flock(lock->fd,LOCK_UN);close(lock->fd);delete lock;}
static napi_value number(napi_env e,int n){napi_value v;napi_create_int32(e,n,&v);return v;}
static int integer(napi_env e,napi_value v){int n=-1;napi_get_value_int32(e,v,&n);return n;}
static std::string string(napi_env e,napi_value v){size_t n=0;napi_get_value_string_utf8(e,v,nullptr,0,&n);std::string s(n+1,'\0');napi_get_value_string_utf8(e,v,s.data(),n+1,&n);s.resize(n);return s;}
static void error(napi_env e,const char* code){napi_throw_error(e,code,code);}
static void dispose(Watch* w){if(w->closed)return;w->closed=true;napi_remove_env_cleanup_hook(w->env,cleanup,w);uv_poll_stop(&w->poll);close(w->fd);napi_delete_reference(w->env,w->callback);uv_close(reinterpret_cast<uv_handle_t*>(&w->poll),[](uv_handle_t* h){delete reinterpret_cast<Watch*>(h->data);});}
static void cleanup(void* data){dispose(static_cast<Watch*>(data));}
static napi_value start(napi_env env,napi_callback_info info){
  size_t n=1;napi_value arg;napi_get_cb_info(env,info,&n,&arg,nullptr,nullptr);
  int fd=inotify_init1(IN_NONBLOCK|IN_CLOEXEC);if(fd<0){error(env,"INOTIFY_UNAVAILABLE");return nullptr;}
  auto* w=new Watch{};w->env=env;w->fd=fd;napi_create_reference(env,arg,1,&w->callback);uv_loop_t* loop;napi_get_uv_event_loop(env,&loop);
  if(uv_poll_init(loop,&w->poll,fd)){close(fd);napi_delete_reference(env,w->callback);delete w;error(env,"INOTIFY_UNAVAILABLE");return nullptr;}
  w->poll.data=w;
  napi_add_env_cleanup_hook(env,cleanup,w);
  uv_poll_start(&w->poll,UV_READABLE,[](uv_poll_t* handle,int status,int){
    auto* w=static_cast<Watch*>(handle->data);if(w->closed)return;
    napi_handle_scope scope;napi_open_handle_scope(w->env,&scope);napi_value events;napi_create_array(w->env,&events);unsigned index=0;
    alignas(inotify_event) char buffer[65536];ssize_t count=status<0?-1:read(w->fd,buffer,sizeof buffer);
    if(count<0&&errno!=EAGAIN){napi_value v;napi_create_object(w->env,&v);napi_set_named_property(w->env,v,"mask",number(w->env,IN_Q_OVERFLOW));napi_set_element(w->env,events,index++,v);}
    for(ssize_t offset=0;offset<count;){auto* event=reinterpret_cast<inotify_event*>(buffer+offset);napi_value v,name;napi_create_object(w->env,&v);
      napi_set_named_property(w->env,v,"wd",number(w->env,event->wd));napi_set_named_property(w->env,v,"mask",number(w->env,event->mask));napi_set_named_property(w->env,v,"cookie",number(w->env,event->cookie));
      napi_create_string_utf8(w->env,event->len?event->name:"",NAPI_AUTO_LENGTH,&name);napi_set_named_property(w->env,v,"name",name);napi_set_element(w->env,events,index++,v);offset+=sizeof(inotify_event)+event->len;}
    napi_value cb,global,result;napi_get_reference_value(w->env,w->callback,&cb);napi_get_global(w->env,&global);napi_call_function(w->env,global,cb,1,&events,&result);napi_close_handle_scope(w->env,scope);
  });
  napi_value result;napi_create_external(env,w,nullptr,nullptr,&result);return result;
}
static napi_value add(napi_env env,napi_callback_info info){size_t n=2;napi_value a[2];napi_get_cb_info(env,info,&n,a,nullptr,nullptr);Watch* w;napi_get_value_external(env,a[0],reinterpret_cast<void**>(&w));
  int wd=inotify_add_watch(w->fd,string(env,a[1]).c_str(),IN_CLOSE_WRITE|IN_MOVED_TO|IN_MOVED_FROM|IN_CREATE|IN_DELETE|IN_DELETE_SELF|IN_MOVE_SELF|IN_ONLYDIR|IN_DONT_FOLLOW);
  if(wd<0){error(env,errno==ENOSPC?"WATCH_LIMIT":"WATCH_UNAVAILABLE");return nullptr;}return number(env,wd);}
static napi_value remove(napi_env env,napi_callback_info info){size_t n=2;napi_value a[2];napi_get_cb_info(env,info,&n,a,nullptr,nullptr);Watch* w;napi_get_value_external(env,a[0],reinterpret_cast<void**>(&w));inotify_rm_watch(w->fd,integer(env,a[1]));return number(env,0);}
static napi_value stop(napi_env env,napi_callback_info info){size_t n=1;napi_value a;napi_get_cb_info(env,info,&n,&a,nullptr,nullptr);Watch* w;napi_get_value_external(env,a,reinterpret_cast<void**>(&w));dispose(w);return number(env,0);}
static napi_value lock(napi_env env,napi_callback_info info){size_t n=1;napi_value a;napi_get_cb_info(env,info,&n,&a,nullptr,nullptr);int fd=open(string(env,a).c_str(),O_CREAT|O_RDWR|O_CLOEXEC|O_NOFOLLOW,0600);struct stat st{};
  if(fd<0||fstat(fd,&st)||!S_ISREG(st.st_mode)||st.st_uid!=getuid()||st.st_nlink!=1){if(fd>=0)close(fd);error(env,"UNSAFE_LOCK");return nullptr;}
  if(flock(fd,LOCK_EX|LOCK_NB)){const int saved=errno;close(fd);if(saved!=EWOULDBLOCK){error(env,"LOCK_UNAVAILABLE");return nullptr;}return number(env,-1);}
  fchmod(fd,0600);auto* held=new Lock{env,fd};{std::lock_guard<std::mutex> guard(locksMutex);locks[fd]=held;}napi_add_env_cleanup_hook(env,cleanupLock,held);return number(env,fd);}
static napi_value unlock(napi_env env,napi_callback_info info){size_t n=1;napi_value a;napi_get_cb_info(env,info,&n,&a,nullptr,nullptr);int fd=integer(env,a);Lock* held=nullptr;{std::lock_guard<std::mutex> guard(locksMutex);const auto found=locks.find(fd);if(found!=locks.end()&&found->second->env==env)held=found->second;}
  if(held){napi_remove_env_cleanup_hook(env,cleanupLock,held);cleanupLock(held);}return number(env,0);}
static napi_value init(napi_env env,napi_value exports){for(auto p:{std::pair<const char*,napi_callback>{"start",start},{"add",add},{"remove",remove},{"stop",stop},{"lock",lock},{"unlock",unlock}}){napi_value f;napi_create_function(env,p.first,NAPI_AUTO_LENGTH,p.second,nullptr,&f);napi_set_named_property(env,exports,p.first,f);}return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
