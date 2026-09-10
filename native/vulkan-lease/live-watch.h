/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef BPANE_LIVE_WATCH_H
#define BPANE_LIVE_WATCH_H
#include <stdbool.h>
#include <sys/types.h>
#define LIVE_HEALTH_PATH "/tmp/.X11-unix/bpane-gpu-health.sock"
int live_health_open(const char *path);
void live_health_reply(int listener, bool healthy);
int live_health_check(const char *path);
bool live_pulse(int fd, double *last);
int live_supervise(pid_t child, int heartbeat, int health, unsigned deadline_ms);
#endif
