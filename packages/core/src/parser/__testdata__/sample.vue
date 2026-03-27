<template>
  <div class="agent-card" :class="[statusClass, { active: isActive }]">
    <header>
      <h2>{{ name }}</h2>
      <span class="status">{{ status }}</span>
    </header>

    <form @submit.prevent="handleSubmit">
      <input v-model="message" placeholder="Enter message..." :disabled="loading" />
      <button type="submit" :disabled="loading || !message.trim()">
        {{ loading ? 'Processing...' : 'Send' }}
      </button>
    </form>

    <div v-if="response" class="response">
      <p>{{ response }}</p>
    </div>

    <ul class="tools">
      <li v-for="tool in tools" :key="tool">{{ tool }}</li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';

interface Props {
  name: string;
  status?: 'active' | 'idle' | 'stopped';
  tools?: string[];
}

const props = withDefaults(defineProps<Props>(), {
  status: 'idle',
  tools: () => [],
});

const emit = defineEmits<{
  process: [message: string];
  statusChange: [status: string];
}>();

const message = ref('');
const response = ref('');
const loading = ref(false);

const isActive = computed(() => props.status === 'active');
const statusClass = computed(() => `status-${props.status}`);

async function handleSubmit() {
  if (!message.value.trim()) return;
  loading.value = true;
  emit('process', message.value);
  // TODO: implement actual API call
  response.value = `Response to: ${message.value}`;
  loading.value = false;
}

function reset() {
  message.value = '';
  response.value = '';
}

watch(() => props.status, (newVal) => {
  console.log(`Status changed to: ${newVal}`);
});

onMounted(() => console.log(`Agent ${props.name} mounted`));
onUnmounted(() => console.log(`Agent ${props.name} unmounted`));
</script>

<style scoped>
.agent-card {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 1rem;
}
.active { border-color: #3b82f6; }
/* FIXME: add responsive styles */
</style>
