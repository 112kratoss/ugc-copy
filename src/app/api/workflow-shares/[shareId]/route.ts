import { NextRequest, NextResponse } from 'next/server';

import { authenticateRequest } from '@/lib/server-helpers';
import {
  isWorkflowShareId,
  toWorkflowSharePreview,
  WORKFLOW_SHARE_SELECT,
  type WorkflowShareRow,
} from '@/lib/workflow-share';

interface RouteParams {
  params: Promise<{ shareId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { shareId } = await params;
  if (!isWorkflowShareId(shareId)) {
    return NextResponse.json({ error: 'Workflow share not found.' }, { status: 404 });
  }

  const { supabase } = auth;
  const { data, error } = await supabase
    .from('workflow_shares')
    .select(WORKFLOW_SHARE_SELECT)
    .eq('id', shareId)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error('Failed to load workflow share snapshot:', error);
    }
    return NextResponse.json({ error: 'Workflow share not found.' }, { status: 404 });
  }

  return NextResponse.json({
    share: toWorkflowSharePreview(data as unknown as WorkflowShareRow, new URL(request.url).origin),
  });
}
