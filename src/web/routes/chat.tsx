// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { Hono } from "hono";
import { Chat } from "../screens/Chat";
import { Layout } from "../_shared/layout";

export function mountChatWebRoutes(app: Hono): void {
  app.get("/chat", (c) => {
    return c.html(
      <Layout title="Chat · siltpoke">
        <Chat />
      </Layout>,
    );
  });
}
