import type { ReactNode } from 'react';

import { ChatScreen } from '../../../../components/ai/chat-screen';

/**
 * Ask AI's full page. The screen lives in this layout, not in the two pages,
 * so moving between a new chat (`/chat`) and a conversation (`/chat/<id>`)
 * keeps the same screen mounted: the list, the search box and the thread
 * stay put while the address changes. The screen reads the id from the
 * address itself.
 */
export default async function ChatLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <>
      <ChatScreen workspaceSlug={workspace} />
      {children}
    </>
  );
}
