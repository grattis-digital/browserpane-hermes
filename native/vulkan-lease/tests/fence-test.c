/* SPDX-License-Identifier: AGPL-3.0-only */
#include "pipeline.h"

static Pipeline *expected_pipeline;
static uint64_t expected_timeout;
static VkResult wait_result;
static unsigned wait_calls;

// Exercise the real wait wrapper without a GPU, wall-clock sleeps or retries.
VKAPI_ATTR VkResult VKAPI_CALL vkWaitForFences(VkDevice device, uint32_t count,
        const VkFence *fences, VkBool32 all, uint64_t timeout) {
    REQUIRE(device==expected_pipeline->device && count==1);
    REQUIRE(fences==&expected_pipeline->fence && all==VK_TRUE);
    REQUIRE(timeout==expected_timeout && timeout<UINT64_MAX);
    wait_calls++;
    return wait_result;
}

static void check(bool software, bool live, uint64_t timeout, VkResult result) {
    Pipeline p={.software=software,.live=live,
        .device=(VkDevice)(uintptr_t)1,.fence=(VkFence)(uintptr_t)2};
    expected_pipeline=&p; expected_timeout=timeout; wait_result=result; wait_calls=0;
    REQUIRE(pipeline_wait(&p)==result);
    REQUIRE(wait_calls==1);
    REQUIRE(p.software==software && p.live==live);
    REQUIRE(p.device==(VkDevice)(uintptr_t)1 && p.fence==(VkFence)(uintptr_t)2);
}

int main(void) {
    VkResult results[]={VK_SUCCESS,VK_TIMEOUT,VK_ERROR_DEVICE_LOST};
    for (unsigned i=0;i<sizeof(results)/sizeof(results[0]);i++) {
        check(false,false,UINT64_C(2000000000),results[i]);
        check(false,true,UINT64_C(2000000000),results[i]);
        check(true,false,UINT64_C(30000000000),results[i]);
        // Even inconsistent live/software state cannot extend a live deadline.
        check(true,true,UINT64_C(2000000000),results[i]);
    }
    puts("Vulkan fence policy: finite software-only allowance, hardware deadline and exact result propagation passed");
    return 0;
}
