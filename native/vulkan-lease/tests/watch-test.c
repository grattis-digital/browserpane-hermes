/* SPDX-License-Identifier: AGPL-3.0-only */
#include "live-watch.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static void worker_case(int health, unsigned mode) {
    int pipefd[2]; assert(!pipe2(pipefd,O_CLOEXEC|O_NONBLOCK));
    pid_t child=fork(); assert(child>=0);
    if (!child) {
        close(pipefd[0]);
        if (mode==0) _exit(0);
        if (mode==1) _exit(7);
        if (mode==2) { raise(SIGKILL); _exit(99); }
        if (mode==3) { raise(SIGSTOP); _exit(99); }
        double pulse=0;
        for (unsigned i=0;i<25;i++) {
            assert(live_pulse(pipefd[1],&pulse));
            (void)poll(NULL,0,100); // Idle screen, no GPU pixels and no traffic.
        }
        _exit(0);
    }
    close(pipefd[1]);
    int result=live_supervise(child,pipefd[0],health,mode==3?200:1500);
    assert(result==((mode==0 || mode==4)?0:1));
    close(pipefd[0]); int status;
    assert(waitpid(child,&status,WNOHANG)==-1 && errno==ECHILD);
}

int main(void) {
    char dir[]="/tmp/bpane-watch-XXXXXX"; assert(mkdtemp(dir));
    char path[108]; assert(snprintf(path,sizeof(path),"%s/health.sock",dir)>0);
    int health=live_health_open(path); assert(health>=0);
    struct stat st; assert(!lstat(path,&st)); assert(S_ISSOCK(st.st_mode) && !(st.st_mode&077));
    for (unsigned mode=0;mode<5;mode++) worker_case(health,mode);
    for (unsigned healthy=0;healthy<2;healthy++) {
        pid_t peer=fork(); assert(peer>=0);
        if (!peer) _exit(live_health_check(path)==(healthy?0:1)?0:1);
        struct pollfd ready={health,POLLIN,0}; assert(poll(&ready,1,2000)>0);
        live_health_reply(health,healthy); int status; assert(waitpid(peer,&status,0)==peer);
        assert(WIFEXITED(status) && !WEXITSTATUS(status));
    }
    // Merely retaining the socket inode is not liveness.
    assert(live_health_check(path)==1);
    close(health); assert(!unlink(path));
    int file=open(path,O_WRONLY|O_CREAT|O_EXCL,0600); assert(file>=0); close(file);
    assert(live_health_open(path)<0); assert(!unlink(path));
    assert(!symlink("missing",path)); assert(live_health_open(path)<0); assert(!unlink(path));
    assert(!rmdir(dir));
    puts("GPU watchdog: clean exit, crash, SIGKILL, stuck worker, idle progress, live health and stale socket passed");
    return 0;
}
