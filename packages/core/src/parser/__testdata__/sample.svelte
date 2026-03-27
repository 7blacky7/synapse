<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  import type { Agent, Status } from './types';

  export let name: string = 'Agent';
  export let status: Status = 'idle';
  export let tools: string[] = [];

  let message = '';
  let response = '';
  let loading = false;

  const dispatch = createEventDispatcher<{
    process: { message: string };
    statusChange: Status;
  }>();

  $: isActive = status === 'active';
  $: toolCount = tools.length;
  $: statusClass = `status-${status}`;

  async function handleSubmit() {
    if (!message.trim()) return;
    loading = true;
    dispatch('process', { message });
    // TODO: implement actual API call
    response = `Response to: ${message}`;
    loading = false;
  }

  function reset() {
    message = '';
    response = '';
    dispatch('statusChange', 'idle');
  }

  onMount(() => {
    console.log(`Agent ${name} mounted`);
    return () => console.log(`Agent ${name} unmounted`);
  });
</script>

<div class="agent-card {statusClass}" class:active={isActive}>
  <header>
    <h2>{name}</h2>
    <span class="status">{status}</span>
    <span class="tools">{toolCount} tools</span>
  </header>

  <form on:submit|preventDefault={handleSubmit}>
    <input bind:value={message} placeholder="Enter message..." disabled={loading} />
    <button type="submit" disabled={loading || !message.trim()}>
      {#if loading}Processing...{:else}Send{/if}
    </button>
  </form>

  {#if response}
    <div class="response" transition:fade>
      <p>{response}</p>
    </div>
  {/if}

  {#each tools as tool}
    <span class="tool-badge">{tool}</span>
  {/each}

  <button on:click={reset}>Reset</button>
</div>

<style>
  .agent-card {
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 1rem;
  }
  .active { border-color: #3b82f6; }
  .status { font-size: 0.875rem; color: #64748b; }
  /* FIXME: add dark mode styles */
</style>
