/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef BPANE_COMPARE_KERNEL_H
#define BPANE_COMPARE_KERNEL_H
#include "lease-client.h"
#define COMPARE_VARIANTS 7
typedef struct { const char *name; unsigned edge; GLuint program, buffer; } CompareKernel;
typedef struct { double setup, submit, wait, total; } CompareTimes;
const char *lease_diff_reference_source(void);
void compare_init(CompareKernel kernels[COMPARE_VARIANTS]);
void compare_close(CompareKernel kernels[COMPARE_VARIANTS]);
CompareTimes compare_run(CompareKernel *, LeaseFrame *, LeaseFrame *, const uint32_t expected[16]);
void compare_fixture(LeaseGpu *, xcb_connection_t *, xcb_screen_t *, xcb_gcontext_t,
                     unsigned width, unsigned height, unsigned scenario, LeaseFrame frames[2]);
void compare_oracle(LeaseFrame *, unsigned scenario);
#endif
