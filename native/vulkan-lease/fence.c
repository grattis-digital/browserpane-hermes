/* SPDX-License-Identifier: AGPL-3.0-only */
#include "pipeline.h"
#include <inttypes.h>

VkResult pipeline_wait(Pipeline *p) {
    // Explicit llvmpipe fixtures can include cold LLVM compilation on CI CPUs.
    // Device selection verifies that mode; live and hardware paths stay at 2s.
    // This is a maximum wait, not a delay, retry or relaxed correctness check.
    bool fixture=p->software && !p->live;
    uint64_t timeout=fixture?UINT64_C(30000000000):UINT64_C(2000000000);
    VkResult result=vkWaitForFences(p->device,1,&p->fence,VK_TRUE,timeout);
    if (result!=VK_SUCCESS) fprintf(stderr,
        "Vulkan fence wait failed: mode=%s deadlineMs=%" PRIu64 " result=%d\n",
        fixture?"software-fixture":"hardware",timeout/UINT64_C(1000000),result);
    return result;
}
