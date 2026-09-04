// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { Hono } from "hono";
import { Chat } from "../screens/Chat";
import { Layout } from "../_shared/layout";

export interface ChatWebRouteDeps {
  /**
   * Daemon secret — forwarded to `<Layout secret>` so FloatingChat's
   * data-secret carries it (chat-stream.ts's own `POST /api/chat` reads it
   * via `document.querySelector("[data-secret]")`, same idiom).
   */
  secret?: string;
}

export function mountChatWebRoutes(app: Hono, deps: ChatWebRouteDeps = {}): void {
  app.get("/chat", (c) => {
    return c.html(
      <Layout title="Chat · siltpoke" secret={deps.secret}>
        <Chat />
      </Layout>,
    );
  });
}
