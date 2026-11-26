import type * as React from 'react';
import { BookOpenIcon } from 'lucide-react';
import { KnowledgeSettings } from '@/KnowledgeSettings';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import type { Status } from '@/api';

export interface KnowledgePageViewProps {
  status: Status;
  busy: string;
}

export function KnowledgePageView({
  status,
  busy,
}: KnowledgePageViewProps): React.ReactElement {
  return (
    <div className="mx-auto max-w-[1240px] space-y-5 px-6 py-5">
      <PageHeader
        title="知识库与人格"
        description="维护本地事实知识、采纳聊天表达样本、发布或回退回复人格，并在零外发沙盒中试聊对比"
        actions={
          <Badge variant={status.account ? 'success' : 'secondary'}>
            <BookOpenIcon />
            {status.account ? '已绑定本地账号' : '尚未核验账号'}
          </Badge>
        }
      />
      <KnowledgeSettings
        key={status.account?.id ?? 'unbound'}
        accountId={status.account?.id ?? null}
        disabled={!!busy}
      />
    </div>
  );
}
