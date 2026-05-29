// Ported from YELP/test/extract.mjs and extract-inbox.mjs.
// Pulls structured leads + messages from the Apollo state Yelp inlines in every page.

interface ApolloRecord { [k: string]: unknown }

const ts = (c: unknown): string | null => {
  if (c && typeof c === 'object' && 'utcDateTime' in c) return String((c as { utcDateTime: string }).utcDateTime);
  return typeof c === 'string' ? c : null;
};

export interface YelpMessage {
  id: string;
  sender: 'business' | 'customer';
  createdAt: string | null;
  text: string | null;
  eventType: string | null;
}

export function extractMessages(state: Record<string, ApolloRecord>): YelpMessage[] {
  return Object.entries(state)
    .filter(([k, v]) => k.startsWith('ConversationMessage:') && v && (v as { eventData?: string }).eventData)
    .map(([, m]) => {
      const r = m as { encid: string; senderIsBusiness: boolean; createdAt: unknown; eventData: string };
      let parsed: { fallback_text?: string; event_type?: string } = {};
      try { parsed = JSON.parse(r.eventData); } catch { /* noop */ }
      return {
        id: r.encid,
        sender: r.senderIsBusiness ? 'business' : 'customer',
        createdAt: ts(r.createdAt),
        text: parsed.fallback_text ?? null,
        eventType: parsed.event_type ?? null,
      } satisfies YelpMessage;
    })
    .filter((m) => !!m.text)
    .sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
}

export interface YelpLeadDetails {
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  service?: string;
  location?: string;
  urgency?: string;
  communicationPreference?: string;
  notes?: string;
}

export function extractLeadDetails(state: Record<string, ApolloRecord>): YelpLeadDetails {
  if (!state || typeof state !== 'object') return {};
  const find = (prefix: string): Record<string, unknown> | undefined =>
    Object.entries(state).find(([k]) => k.startsWith(prefix))?.[1] as Record<string, unknown> | undefined;

  const user = find('User:');
  const project = find('Project:');
  const lead = find('Lead:');

  const customerName = (user?.displayName as string | undefined) ?? undefined;
  const service = (project?.name as string | undefined) ?? undefined;
  const zip = project?.zip as string | undefined;
  const loc = lead?.location as { city?: string; state?: string } | undefined;
  const city = loc?.city;
  const stateCode = loc?.state;
  const location = [city && stateCode ? `${city}, ${stateCode}` : (city ?? stateCode), zip].filter(Boolean).join(' ') || undefined;

  const phoneInfo = lead?.phoneNumberConnectionInfo as { consumerPhoneNumber?: string } | undefined;
  const customerPhone = phoneInfo?.consumerPhoneNumber || undefined;
  const customerEmail = (user?.email as string | undefined) || undefined;
  const urgency = (project?.urgency as { level?: string } | undefined)?.level;
  const commPref = (project?.communicationPreference as string | undefined) || undefined;
  const surveyQA = project?.surveyQuestionAnswers as Array<{ question: string; answers?: string[] }> | undefined;

  const notes = Array.isArray(surveyQA) && surveyQA.length
    ? surveyQA.map((qa) => `${qa.question}\n${(qa.answers ?? []).join(', ')}`).join('\n\n')
    : (project?.description as string | undefined) || undefined;

  return { customerName, customerEmail, customerPhone, service, location, urgency, communicationPreference: commPref, notes };
}

export interface YelpInboxItem {
  leadEncid: string;
  url: string;
  status: string;
  needsAttention: boolean;
  lastEventTime: string | null;
  previewText: string;
  latestIsCustomer: boolean;
  customerHasUnreadMessage: boolean;
  projectCategory: string | null;
}

export function extractInbox(state: Record<string, ApolloRecord>, bizEncid: string): YelpInboxItem[] {
  const out: YelpInboxItem[] = [];
  for (const [k, v] of Object.entries(state)) {
    if (!k.startsWith('Lead:')) continue;
    const lead = v as Record<string, unknown>;
    const conv = lead.conversation as { lastEventTime?: { utcDateTime?: string } } | undefined;
    const preview = lead.leadPreview as { previewText?: string; senderPrefix?: string } | undefined;
    out.push({
      leadEncid: (lead.encid as string) ?? '',
      url: `https://biz.yelp.com/leads_center/${bizEncid}/leads/${lead.encid as string}`,
      status: (lead.status as string) ?? 'UNKNOWN',
      needsAttention: !!lead.needsAttention,
      lastEventTime: ts(conv?.lastEventTime) ?? null,
      previewText: preview?.previewText ?? '',
      latestIsCustomer: !(preview?.senderPrefix?.toLowerCase().includes('you replied')),
      customerHasUnreadMessage: !((lead.conversation as { currentUserHasRead?: boolean } | undefined)?.currentUserHasRead),
      projectCategory: (lead.projectCategory as string | null) ?? null,
    });
  }
  return out;
}
