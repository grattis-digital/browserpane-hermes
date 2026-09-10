/* SPDX-License-Identifier: AGPL-3.0-only */
#include "live-watch.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static double now_ms(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC,&t)) return -1;
    return t.tv_sec*1000.0+t.tv_nsec/1000000.0;
}

int live_health_open(const char *path) {
    struct sockaddr_un address={.sun_family=AF_UNIX};
    if (strlen(path)>=sizeof(address.sun_path)) return -1;
    strcpy(address.sun_path,path);
    struct stat old;
    if (!lstat(path,&old)) {
        if (!S_ISSOCK(old.st_mode) || old.st_uid!=getuid() || unlink(path)) return -1;
    } else if (errno!=ENOENT) return -1;
    int fd=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK,0);
    if (fd<0) return -1;
    mode_t mask=umask(0077);
    int bound=bind(fd,(struct sockaddr *)&address,sizeof(address));
    umask(mask);
    if (bound || listen(fd,8)) { close(fd); return -1; }
    return fd;
}

void live_health_reply(int listener, bool healthy) {
    // A health client cannot block capture or create an unbounded connection list.
    int fd=accept4(listener,NULL,NULL,SOCK_CLOEXEC|SOCK_NONBLOCK);
    if (fd<0) return;
    struct ucred peer; socklen_t length=sizeof(peer);
    if (!getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&peer,&length) &&
        length==sizeof(peer) && peer.uid==getuid()) {
        const char *reply=healthy?"BPH1 OK\n":"BPH1 NO\n";
        (void)send(fd,reply,8,MSG_NOSIGNAL);
    }
    close(fd);
}

int live_health_check(const char *path) {
    struct sockaddr_un address={.sun_family=AF_UNIX};
    if (strlen(path)>=sizeof(address.sun_path)) return 1;
    strcpy(address.sun_path,path);
    int fd=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK,0);
    if (fd<0) return 1;
    int result=1;
    if (!connect(fd,(struct sockaddr *)&address,sizeof(address))) {
        struct ucred peer; socklen_t length=sizeof(peer);
        if (getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&peer,&length) ||
            length!=sizeof(peer) || peer.uid!=getuid()) { close(fd); return 1; }
        char reply[9]={0}; size_t at=0; double deadline=now_ms()+1500;
        while (at<sizeof(reply)) {
            double remaining=deadline-now_ms(); if (remaining<=0) break;
            struct pollfd wait={fd,POLLIN,0};
            int ready=poll(&wait,1,(int)remaining);
            if (ready<0 && errno==EINTR) continue;
            if (ready<=0) break;
            ssize_t n=read(fd,reply+at,sizeof(reply)-at);
            if (n<0 && (errno==EINTR || errno==EAGAIN)) continue;
            if (n<0) break;
            if (!n) { result=at==8 && !memcmp(reply,"BPH1 OK\n",8)?0:1; break; }
            at+=(size_t)n;
        }
    }
    close(fd); return result;
}

bool live_pulse(int fd, double *last) {
    if (fd<0) return true; // Standalone synthetic --serve owns no supervisor.
    double now=now_ms(); if (now<0) return false;
    if (now-*last<1000) return true;
    const char pulse=1;
    ssize_t sent=write(fd,&pulse,1);
    if (sent==1) { *last=now; return true; }
    return sent<0 && (errno==EAGAIN || errno==EINTR);
}

static void stop_child(pid_t child) {
    (void)kill(child,SIGTERM);
    double deadline=now_ms()+2000; int status;
    while (now_ms()<deadline) {
        pid_t done=waitpid(child,&status,WNOHANG);
        if (done==child || (done<0 && errno==ECHILD)) return;
        (void)poll(NULL,0,20);
    }
    (void)kill(child,SIGKILL);
    while (waitpid(child,&status,0)<0 && errno==EINTR) {}
}

int live_supervise(pid_t child, int heartbeat, int health, unsigned deadline_ms) {
    double seen=now_ms();
    for (;;) {
        int status=0; pid_t done=waitpid(child,&status,WNOHANG);
        if (done==child) {
            if (WIFEXITED(status) && WEXITSTATUS(status)==0) return 0;
            fprintf(stderr,"GPU worker failed: status=%d; restarting display generation\n",status);
            return 1;
        }
        if (done<0 && errno!=EINTR) return 1;
        double now=now_ms();
        if (now<0 || now-seen>=deadline_ms) {
            fprintf(stderr,"GPU worker progress timed out; restarting display generation\n");
            live_health_reply(health,false); stop_child(child); return 1;
        }
        struct pollfd fds[]={{heartbeat,POLLIN,0},{health,POLLIN,0}};
        int ready=poll(fds,2,100);
        if (ready<0 && errno!=EINTR) { stop_child(child); return 1; }
        if (fds[0].revents&POLLIN) {
            char bytes[64]; ssize_t n=read(heartbeat,bytes,sizeof(bytes));
            if (n>0) seen=now_ms();
        }
        if (fds[1].revents&POLLIN) live_health_reply(health,true);
        // Closed pipe while the process is tearing down must not busy-spin.
        if (fds[0].revents&POLLHUP) (void)poll(NULL,0,20);
    }
}
