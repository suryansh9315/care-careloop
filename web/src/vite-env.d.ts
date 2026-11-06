/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MEDPLUM_BASE_URL?: string;
  readonly VITE_MEDPLUM_CLIENT_ID?: string;
  readonly VITE_MEDPLUM_PROJECT_ID?: string;
  readonly VITE_BRIDGE_URL?: string;
  readonly VITE_BRIDGE_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
