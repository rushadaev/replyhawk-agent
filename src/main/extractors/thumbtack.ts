// Ported from YELP/test/extract-thumbtack.mjs.
// Builds a normalized lead from a Thumbtack MessengerStreamQuery response + sidebar panel text.

export interface ThumbtackMessage {
  id: string;
  sender: 'business' | 'customer';
  text: string;
  createdAt: string;
}

interface SimpleMessage {
  __typename: string;
  message?: string;
  simpleEventHeader?: { title?: string };
  items?: Array<{ texts?: Array<{ __typename?: string; e164PhoneNumber?: string }> }>;
  systemMessage?: { text?: { segments?: Array<{ text?: string }> } };
  commonFields?: { messagePk?: string; alignment?: string; timestamp?: string };
}

export interface ParsedPanel {
  service?: string;
  location?: string;
  fields: Record<string, string>;
  estimatedCost?: string;
}

export function parseThumbtackPanel(panelText?: string | null): ParsedPanel | null {
  if (!panelText) return null;
  const lines = panelText.split('\n').map((l) => l.trim()).filter(Boolean);
  const service = lines[0];
  const location = /^[A-Z][a-zA-Z .'-]+, [A-Z]{2}( \d{5})?$/.test(lines[1] ?? '') ? lines[1] : undefined;
  const fields: Record<string, string> = {};
  for (const l of lines) {
    const m = l.match(/^([A-Z][^:]{2,40}):\s+(.+)$/);
    if (m) fields[m[1].trim()] = m[2].trim();
  }
  const costIdx = lines.indexOf('Estimated cost');
  const costLines = costIdx >= 0 ? lines.slice(costIdx + 1).filter((l) => /^\$/.test(l) || /minimum/i.test(l)) : [];
  return { service, location, fields, estimatedCost: costLines.length ? costLines.join(' · ') : undefined };
}

export interface ThumbtackLead {
  source: 'thumbtack';
  sourceLeadId: string;
  sourceUrl: string;
  customerName?: string;
  customerPhone?: string;
  service?: string;
  location?: string;
  notes?: string;
  messages: ThumbtackMessage[];
  panelFields?: Record<string, string>;
}

export function extractThumbtackLead(args: {
  stream: { messages?: SimpleMessage[] } | null;
  panel?: string | null;
  bidPk: string;
  url: string;
}): ThumbtackLead {
  const { stream, panel, bidPk, url } = args;
  const messages: ThumbtackMessage[] = [];
  let customerPhone: string | undefined;
  let customerName: string | undefined;

  for (const m of stream?.messages ?? []) {
    const t = m.__typename;
    if (t === 'MessengerStreamSystemMessage') {
      const text = (m.systemMessage?.text?.segments ?? []).map((s) => s.text ?? '').join('');
      const match = text.match(/^(.+?)\s+started a conversation/);
      if (match && !customerName) customerName = match[1].trim();
    }
    if (t === 'MessengerStreamSimpleEvent' && m.simpleEventHeader?.title === 'Contact information') {
      for (const item of m.items ?? []) {
        for (const x of item.texts ?? []) {
          if (x.__typename === 'PhoneNumber' && x.e164PhoneNumber) customerPhone = x.e164PhoneNumber;
        }
      }
    }
    if (t === 'MessengerStreamSimpleMessage' && m.message) {
      messages.push({
        id: m.commonFields?.messagePk ?? '',
        sender: m.commonFields?.alignment === 'OUTBOUND' ? 'business' : 'customer',
        text: m.message,
        createdAt: m.commonFields?.timestamp ?? '',
      });
    }
  }
  messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const panelData = parseThumbtackPanel(panel);
  const projectBlock = panelData?.fields && Object.keys(panelData.fields).length
    ? Object.entries(panelData.fields).map(([k, v]) => `${k}: ${v}`).join('\n')
    : null;
  const convBlock = messages.length ? messages.map((m) => `${m.sender}: ${m.text}`).join('\n\n') : null;
  const notes = [
    projectBlock && `=== Project details ===\n${projectBlock}`,
    panelData?.estimatedCost && `Estimated cost: ${panelData.estimatedCost}`,
    convBlock && `=== Conversation ===\n${convBlock}`,
  ].filter(Boolean).join('\n\n') || undefined;

  return {
    source: 'thumbtack',
    sourceLeadId: bidPk,
    sourceUrl: url,
    customerName,
    customerPhone,
    service: panelData?.service,
    location: panelData?.location,
    notes,
    messages,
    panelFields: panelData?.fields,
  };
}
