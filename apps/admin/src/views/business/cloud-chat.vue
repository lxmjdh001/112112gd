<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { api } from "#/api/business";
import { mountCloudChat } from "../../../../../packages/cloud-chat/index";
import "../../../../../packages/cloud-chat/style.css";
const props = defineProps<{ numberId: string }>();
const host = ref<HTMLElement>();
let widget: ReturnType<typeof mountCloudChat> | undefined;
function mount() {
  widget?.dispose();
  if (!host.value || !props.numberId) return;
  const number = props.numberId;
  widget = mountCloudChat(host.value, {
    request: async <T>(path: string, body?: unknown, method?: string): Promise<T> => {
      const route = `/whatsapp-cloud/numbers/${number}${path}`;
      if (method === "PUT") return api.put<T>(route, body, { timeout: 30000 });
      return body === undefined
        ? api.get<T>(route, { timeout: 30000 })
        : api.post<T>(route, body, { timeout: 30000 });
    },
  });
}
onMounted(mount);
watch(() => props.numberId, mount);
onBeforeUnmount(() => widget?.dispose());
</script>
<template><div ref="host" class="cloud-chat-host" /></template>
<style scoped>
.cloud-chat-host {
  height: calc(100vh - 315px);
  min-height: 570px;
}
</style>
