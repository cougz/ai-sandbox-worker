// Mountable entry point for embedding the OpenCode app in a host application.
// Usage: import { mount } from "./mount"
//        const dispose = mount(element, { serverUrl: "http://...", directory: "/home/user/workspace" })

import { base64Encode } from "@opencode-ai/util/encode";
import { HashRouter } from "@solidjs/router";
import { render } from "solid-js/web";
import { AppBaseProviders, AppInterface } from "@/app";
import { type Platform, PlatformProvider } from "@/context/platform";
import pkg from "../package.json";
import { ServerConnection } from "./context/server";

export interface MountConfig {
  serverUrl: string;
  directory?: string;
  sessionId?: string;
}

export function mount(element: HTMLElement, config: MountConfig): () => void {
  // Force light mode so embedded UI matches the host shell
  localStorage.setItem("opencode-color-scheme", "light");

  if (config.directory) {
    const base = `#/${base64Encode(config.directory)}/session`;
    window.location.hash = config.sessionId ? `${base}/${config.sessionId}` : base;
  }

  const server: ServerConnection.Http = {
    type: "http",
    http: { url: config.serverUrl },
  };

  const key = ServerConnection.Key.make(config.serverUrl);

  const platform: Platform = {
    platform: "web",
    version: pkg.version,
    openLink: (url) => window.open(url, "_blank"),
    back: () => {},
    forward: () => {},
    restart: async () => window.location.reload(),
    notify: async () => {},
    getDefaultServer: async () => key,
    setDefaultServer: () => {},
  };

  const dispose = render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface defaultServer={key} servers={[server]} router={HashRouter} disableHealthCheck />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    element,
  );

  return dispose;
}
