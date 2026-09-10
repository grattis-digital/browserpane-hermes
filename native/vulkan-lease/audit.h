/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef BPANE_VULKAN_AUDIT_H
#define BPANE_VULKAN_AUDIT_H
#include "pipeline.h"
enum { AUDIT_EMPTY, AUDIT_BARE, AUDIT_CLASSIFY, AUDIT_COMPACT, AUDIT_FULL, AUDIT_STAGES };
enum { AUDIT_SINGLE, AUDIT_SERIAL, AUDIT_BATCH, AUDIT_MODES };
enum { AUDIT_REPEAT=8, AUDIT_WARMUP=1, AUDIT_ROUNDS=6, AUDIT_ENGINES=6, AUDIT_CLIENTS=16 };
typedef struct { uint64_t id, ns[AUDIT_ENGINES], jobs[AUDIT_ENGINES]; } AuditClient;
typedef struct { unsigned count; AuditClient clients[AUDIT_CLIENTS]; } AuditCounters;
void audit_record(Pipeline *, Params, unsigned stage, unsigned repeats);
void audit_check(Pipeline *, Params, const Oracle *, unsigned stage);
void audit_counters(AuditCounters *);
void audit_counter_print(const AuditCounters *, const AuditCounters *);
#endif
