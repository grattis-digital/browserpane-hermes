/* SPDX-License-Identifier: AGPL-3.0-only */
#include "live.h"
#include "live-watch.h"
#include <poll.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

int live_listen(void) {
    const char *path="/tmp/.X11-unix/bpane-gpu-tail.sock";
    REQUIRE(getuid()==10000);
    struct stat existing;
    if (!lstat(path,&existing)) {
        REQUIRE(S_ISSOCK(existing.st_mode) && existing.st_uid==getuid());
        REQUIRE(!unlink(path));
    } else REQUIRE(errno==ENOENT);
    int server=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0); REQUIRE(server>=0);
    struct sockaddr_un address={.sun_family=AF_UNIX};
    REQUIRE(strlen(path)<sizeof(address.sun_path)); strcpy(address.sun_path,path);
    mode_t previous=umask(0077);
    REQUIRE(!bind(server,(struct sockaddr *)&address,sizeof(address))); umask(previous);
    REQUIRE(!listen(server,1));
    int health=live_health_open(LIVE_HEALTH_PATH); REQUIRE(health>=0);
    for (;;) {
        struct pollfd listeners[]={{server,POLLIN,0},{health,POLLIN,0}};
        int ready=poll(listeners,2,-1);
        if (ready<0 && errno==EINTR) continue;
        REQUIRE(ready>=0);
        if (listeners[1].revents&POLLIN) live_health_reply(health,true);
        if (!(listeners[0].revents&POLLIN)) continue;
        int fd=accept4(server,NULL,NULL,SOCK_CLOEXEC);
        if (fd<0 && errno==EINTR) continue;
        REQUIRE(fd>=0);
        struct ucred peer; socklen_t size=sizeof(peer);
        if (getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&peer,&size) || size!=sizeof(peer) || peer.uid!=getuid()) {
            close(fd); continue;
        }
        int heartbeat[2]; REQUIRE(!pipe2(heartbeat,O_CLOEXEC|O_NONBLOCK));
        pid_t parent=getpid(),child=fork(); REQUIRE(child>=0);
        if (!child) {
            REQUIRE(!prctl(PR_SET_PDEATHSIG,SIGTERM) && getppid()==parent);
            close(server);
            close(health); close(heartbeat[0]);
            int flags=fcntl(fd,F_GETFL); REQUIRE(flags>=0);
            REQUIRE(!fcntl(fd,F_SETFL,flags|O_NONBLOCK));
            REQUIRE(dup2(fd,STDIN_FILENO)>=0 && dup2(fd,STDOUT_FILENO)>=0); close(fd);
            Pipeline p; pipeline_open(&p,false,false);
            int result=live_main(&p,heartbeat[1]); pipeline_close(&p); _exit(result);
        }
        close(fd); close(heartbeat[1]);
        int failed=live_supervise(child,heartbeat[0],health,15000);
        close(heartbeat[0]);
        if (failed) { close(server); close(health); return 1; }
    }
}
