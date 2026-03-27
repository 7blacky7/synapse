#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "synapse.h"

#define MAX_RETRIES 3
#define BUFFER_SIZE 4096
#define VERSION "1.0.0"

typedef enum {
    STATUS_ACTIVE,
    STATUS_IDLE,
    STATUS_STOPPED,
    STATUS_ERROR
} AgentStatus;

typedef struct {
    char *model;
    int max_tokens;
    double temperature;
} AgentConfig;

typedef struct Agent {
    char name[256];
    AgentConfig config;
    AgentStatus status;
    struct Agent *next;
} Agent;

static Agent *agent_list = NULL;
static int agent_count = 0;

Agent *agent_create(const char *name, AgentConfig *config) {
    Agent *agent = (Agent *)malloc(sizeof(Agent));
    if (!agent) return NULL;

    strncpy(agent->name, name, 255);
    agent->name[255] = '\0';
    agent->config = *config;
    agent->status = STATUS_IDLE;
    agent->next = NULL;

    agent_count++;
    return agent;
}

void agent_destroy(Agent *agent) {
    if (!agent) return;
    free(agent->config.model);
    free(agent);
    agent_count--;
}

int agent_process(Agent *agent, const char *message, char *output, size_t out_size) {
    if (!agent || !message) return -1;
    agent->status = STATUS_ACTIVE;
    snprintf(output, out_size, "Response to: %s", message);
    agent->status = STATUS_IDLE;
    return 0;
}

AgentStatus agent_get_status(const Agent *agent) {
    return agent ? agent->status : STATUS_ERROR;
}

static void cleanup_all(void) {
    Agent *curr = agent_list;
    while (curr) {
        Agent *next = curr->next;
        agent_destroy(curr);
        curr = next;
    }
}

// TODO: add thread safety
// FIXME: potential buffer overflow in agent_process
