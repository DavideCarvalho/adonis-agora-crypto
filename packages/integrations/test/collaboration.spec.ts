import { describe, expect, it } from 'vitest';
import { memoryCrypto, memorySubjectKeys } from '../../adonis/src/testing/index.js';
import {
  COLLABORATION_ENVELOPE_PREFIX,
  type CollaborationCodecContext,
  type CollaborationCodecValue,
  collaborationAad,
  collaborationCodec,
  type SubjectCipher,
} from '../src/collaboration.js';

const STACK = Symbol.for('@adonis-agora/stack');

const OWNERS: Record<string, string> = { p1: 'u-1', p2: 'u-2' };
const researcherSubject = (userId: string) => ({ type: 'researcher', id: userId });
const projectOwnerId = async (projectId: string) => {
  const owner = OWNERS[projectId];
  if (!owner) throw new Error(`no project ${projectId}`);
  return owner;
};

/**
 * A verbatim copy of Entre Textos' hand-written codec (apps/entre-textos/app/researcher/services/
 * writing_collaboration_codec.ts, before the switch), with `crypto.subjects` injected.
 */
function etLegacyCodec(subjects: SubjectCipher) {
  const WRITING_DOC = /^projects\/([^/]+)\/writing$/;
  const thesisProjectOf = (ctx: CollaborationCodecContext) =>
    WRITING_DOC.exec(ctx.docName)?.[1] ?? null;
  const aadOf = (ctx: CollaborationCodecContext) =>
    JSON.stringify([
      'agora:collab',
      ctx.docName,
      ctx.kind,
      ctx.field,
      ctx.versionId ?? ctx.commentId ?? null,
    ]);
  const isText = (ctx: CollaborationCodecContext) => ctx.field === 'body' || ctx.field === 'anchor';
  return {
    async encode(plaintext: CollaborationCodecValue, ctx: CollaborationCodecContext) {
      const projectId = thesisProjectOf(ctx);
      if (!projectId) return plaintext;
      const owner = await projectOwnerId(projectId);
      const text =
        typeof plaintext === 'string' ? plaintext : Buffer.from(plaintext).toString('base64');
      return subjects.encrypt(researcherSubject(owner), text, { aad: aadOf(ctx) });
    },
    async decode(encoded: CollaborationCodecValue, ctx: CollaborationCodecContext) {
      const projectId = thesisProjectOf(ctx);
      if (!projectId) return encoded;
      const owner = await projectOwnerId(projectId);
      const ciphertext =
        typeof encoded === 'string' ? encoded : Buffer.from(encoded).toString('utf8');
      const text = await subjects.decrypt(ciphertext, {
        subject: researcherSubject(owner),
        aad: aadOf(ctx),
      });
      return isText(ctx) ? text : new Uint8Array(Buffer.from(text, 'base64'));
    },
  };
}

/** The new codec with Entre Textos' options. */
function etNewCodec(subjects: SubjectCipher) {
  return collaborationCodec({
    docs: /^projects\/([^/]+)\/writing$/,
    subjects: () => subjects,
    subject: async ([, projectId]) => researcherSubject(await projectOwnerId(projectId!)),
  });
}

const state = Uint8Array.from([1, 2, 3, 0, 255, 128, 7]);
const CONTEXTS: Array<{ ctx: CollaborationCodecContext; value: CollaborationCodecValue }> = [
  { ctx: { docName: 'projects/p1/writing', kind: 'document', field: 'state' }, value: state },
  {
    ctx: { docName: 'projects/p1/writing', kind: 'version', field: 'snapshot', versionId: 'v-9' },
    value: state,
  },
  {
    ctx: { docName: 'projects/p1/writing', kind: 'comment', field: 'body', commentId: 'c-3' },
    value: 'a comment with accents: ção ü',
  },
  {
    ctx: { docName: 'projects/p1/writing', kind: 'comment', field: 'anchor', commentId: 'c-3' },
    value: JSON.stringify({ type: 'text-range', quote: 'quoted' }),
  },
];

const decodeAs = (value: CollaborationCodecValue) =>
  typeof value === 'string' ? value : Array.from(value);

/** What the collaboration storage hands decode for a value: a string as is, bytes as bytes. */
const stored = (value: CollaborationCodecValue) =>
  typeof value === 'string' ? value : new Uint8Array(Buffer.from(value));

describe('collaborationCodec: Entre Textos compatibility', () => {
  it('reads every value the old hand-written codec wrote, and the old codec reads the new ones', async () => {
    const { subjects } = memorySubjectKeys();
    const legacy = etLegacyCodec(subjects);
    const codec = etNewCodec(subjects);

    for (const { ctx, value } of CONTEXTS) {
      const oldCipher = await legacy.encode(value, ctx);
      expect(decodeAs(await codec.decode(stored(oldCipher), ctx))).toEqual(decodeAs(value));

      const newCipher = await codec.encode(value, ctx);
      expect(decodeAs(await legacy.decode(stored(newCipher), ctx))).toEqual(decodeAs(value));

      // Same format: an agora:se1 string for the owner's subject key.
      expect(typeof newCipher).toBe('string');
      expect(newCipher as string).toMatch(/^agora:se1:subject_researcher_u-1:[0-9a-f]{32}:/);
      expect(typeof oldCipher).toBe('string');
      expect((oldCipher as string).split(':').slice(0, 3)).toEqual(
        (newCipher as string).split(':').slice(0, 3),
      );
    }
  });

  it('reads a value the old codec wrote as bytes (a binary column hands back bytes)', async () => {
    const { subjects } = memorySubjectKeys();
    const ctx = CONTEXTS[0]!.ctx;
    const oldCipher = (await etLegacyCodec(subjects).encode(state, ctx)) as string;
    const asBytes = new Uint8Array(Buffer.from(oldCipher, 'utf8'));
    expect(Array.from((await etNewCodec(subjects).decode(asBytes, ctx)) as Uint8Array)).toEqual(
      Array.from(state),
    );
  });

  it('the default AAD is exactly the one Entre Textos used', () => {
    const ctx = CONTEXTS[1]!.ctx;
    expect(collaborationAad(ctx)).toBe(
      JSON.stringify(['agora:collab', 'projects/p1/writing', 'version', 'snapshot', 'v-9']),
    );
    expect(collaborationAad({ docName: 'd', kind: 'document', field: 'state' })).toBe(
      '["agora:collab","d","document","state",null]',
    );
  });

  it('passes the other documents through untouched, both ways', async () => {
    const { subjects } = memorySubjectKeys();
    const codec = etNewCodec(subjects);
    const ctx: CollaborationCodecContext = {
      docName: 'whiteboards/w1/canvas',
      kind: 'document',
      field: 'state',
    };
    expect(await codec.encode(state, ctx)).toBe(state);
    expect(await codec.decode(state, ctx)).toBe(state);
    // A name that only resembles the thesis does not match.
    const near: CollaborationCodecContext = { ...ctx, docName: 'projects/p1/writing/extra' };
    expect(await codec.encode(state, near)).toBe(state);
  });

  it('a regex with the g flag still matches every call', async () => {
    const { subjects } = memorySubjectKeys();
    const codec = collaborationCodec({
      docs: /^projects\/([^/]+)\/writing$/g,
      subjects,
      subject: ([, id]) => researcherSubject(OWNERS[id!]!),
    });
    const ctx = CONTEXTS[0]!.ctx;
    for (let i = 0; i < 3; i++) expect(typeof (await codec.encode(state, ctx))).toBe('string');
  });
});

describe('collaborationCodec: failures throw', () => {
  it('a value moved to another row, column or document does not open', async () => {
    const { subjects } = memorySubjectKeys();
    const codec = etNewCodec(subjects);
    const ctx = CONTEXTS[1]!.ctx;
    const cipher = await codec.encode(state, ctx);
    await expect(codec.decode(cipher, { ...ctx, versionId: 'v-10' })).rejects.toThrow();
    await expect(
      codec.decode(cipher, { ...ctx, kind: 'document', field: 'state' }),
    ).rejects.toThrow();
    await expect(
      codec.decode(cipher, { ...ctx, docName: 'projects/p2/writing' }),
    ).rejects.toThrow();
  });

  it('a tampered or plain value throws instead of returning garbage', async () => {
    const { subjects } = memorySubjectKeys();
    const codec = etNewCodec(subjects);
    const ctx = CONTEXTS[2]!.ctx;
    const cipher = (await codec.encode('secret body', ctx)) as string;
    const last = cipher.at(-2) === 'A' ? 'B' : 'A';
    const tampered = `${cipher.slice(0, -2)}${last}${cipher.at(-1)}`;
    await expect(codec.decode(tampered, ctx)).rejects.toThrow();
    await expect(codec.decode('just text', ctx)).rejects.toThrow();
    try {
      await codec.decode(tampered, ctx);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('secret body');
    }
  });

  it('a subject resolver failure reaches the caller', async () => {
    const { subjects } = memorySubjectKeys();
    const codec = etNewCodec(subjects);
    await expect(
      codec.encode(state, { docName: 'projects/nope/writing', kind: 'document', field: 'state' }),
    ).rejects.toThrow(/no project nope/);
  });

  it('rejects incomplete options', () => {
    expect(() => collaborationCodec({} as never)).toThrow(TypeError);
    expect(() =>
      collaborationCodec({ subjects: {} as SubjectCipher, subject: undefined } as never),
    ).toThrow(TypeError);
    expect(() =>
      collaborationCodec({
        source: { service: memoryCrypto().service, partition: 'shop' },
      } as never),
    ).toThrow(TypeError);
  });
});

async function keySetup() {
  const crypto = memoryCrypto();
  await crypto.service.createKey(crypto.principal, { name: 'collab', type: 'aes256-gcm' });
  await crypto.service.createKey(crypto.principal, { name: 'collab-b', type: 'aes256-gcm' });
  const calls = { encrypt: 0, decrypt: 0 };
  const source = {
    client: {
      encrypt: (input: Parameters<typeof crypto.service.encrypt>[1]) => {
        calls.encrypt++;
        return crypto.service.encrypt(crypto.principal, input);
      },
      decrypt: (input: Parameters<typeof crypto.service.decrypt>[1]) => {
        calls.decrypt++;
        return crypto.service.decrypt(crypto.principal, input);
      },
    },
  } as never;
  return { crypto, source, calls };
}

describe('collaborationCodec: named key', () => {
  it('seals with the key on the crypto server (default: every document)', async () => {
    const { source, calls } = await keySetup();
    const codec = collaborationCodec({ source, key: 'collab' });
    for (const { ctx, value } of CONTEXTS) {
      const cipher = await codec.encode(value, ctx);
      expect(cipher as string).toMatch(/^agora:ct1:/);
      expect(decodeAs(await codec.decode(stored(cipher), ctx))).toEqual(decodeAs(value));
    }
    expect(calls.encrypt).toBe(CONTEXTS.length);
  });

  it('picks the key per document', async () => {
    const { source } = await keySetup();
    const codec = collaborationCodec({
      source,
      docs: (name) => (name.startsWith('b/') ? 'b' : name.startsWith('a/') ? 'a' : null),
      key: (match) => (match === 'b' ? 'collab-b' : 'collab'),
    });
    const ctx: CollaborationCodecContext = { docName: 'b/1', kind: 'document', field: 'state' };
    const cipher = await codec.encode(state, ctx);
    const wrongKey = collaborationCodec({ source, key: 'collab' });
    await expect(wrongKey.decode(cipher, ctx)).rejects.toThrow();
    expect(Array.from((await codec.decode(cipher, ctx)) as Uint8Array)).toEqual(Array.from(state));
    expect(await codec.encode(state, { ...ctx, docName: 'c/1' })).toBe(state);
  });
});

describe('collaborationCodec: envelope mode (opt-in)', () => {
  it('seals locally under a cached data key per document: one server call per document', async () => {
    const { source, calls } = await keySetup();
    const codec = collaborationCodec({ source, key: 'collab', envelope: true });
    for (const { ctx, value } of CONTEXTS) {
      const cipher = await codec.encode(value, ctx);
      expect(cipher as string).toMatch(/^agora:ce1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
      expect(decodeAs(await codec.decode(stored(cipher), ctx))).toEqual(decodeAs(value));
    }
    expect(calls.encrypt).toBe(1);
    // Decoding on a fresh codec unwraps once, then hits its cache.
    const reader = collaborationCodec({ source, key: 'collab', envelope: true });
    const cipher = await codec.encode(state, CONTEXTS[0]!.ctx);
    await reader.decode(cipher, CONTEXTS[0]!.ctx);
    await reader.decode(cipher, CONTEXTS[0]!.ctx);
    expect(calls.decrypt).toBe(1);
  });

  it('both formats open whichever mode the codec is in now', async () => {
    const { source } = await keySetup();
    const plain = collaborationCodec({ source, key: 'collab' });
    const envelope = collaborationCodec({ source, key: 'collab', envelope: { ttlMs: 1000 } });
    const ctx = CONTEXTS[0]!.ctx;
    const a = await plain.encode(state, ctx);
    const b = await envelope.encode(state, ctx);
    expect(b as string).toMatch(new RegExp(`^${COLLABORATION_ENVELOPE_PREFIX}`));
    for (const codec of [plain, envelope]) {
      for (const cipher of [a, b]) {
        expect(Array.from((await codec.decode(cipher, ctx)) as Uint8Array)).toEqual(
          Array.from(state),
        );
      }
    }
  });

  it('a value moved to another document, row or column, or tampered, throws', async () => {
    const { source } = await keySetup();
    const codec = collaborationCodec({ source, key: 'collab', envelope: true });
    const ctx = CONTEXTS[1]!.ctx;
    const cipher = (await codec.encode(state, ctx)) as string;
    await expect(codec.decode(cipher, { ...ctx, versionId: 'other' })).rejects.toThrow();
    await expect(
      codec.decode(cipher, { ...ctx, docName: 'projects/p2/writing' }),
    ).rejects.toThrow();
    const body = cipher.slice(cipher.lastIndexOf(':') + 1);
    const flipped = `${body.slice(0, 20)}${body[20] === 'A' ? 'B' : 'A'}${body.slice(21)}`;
    await expect(codec.decode(cipher.replace(body, flipped), ctx)).rejects.toThrow(/did not open/);
    await expect(codec.decode('agora:ce1:nope', ctx)).rejects.toThrow(/malformed/);
    // A wrapped data key from another document does not open here either.
    const other = (await codec.encode(state, { ...ctx, docName: 'x/1' })) as string;
    const swapped = `${other.slice(0, other.lastIndexOf(':'))}:${body}`;
    await expect(codec.decode(swapped, ctx)).rejects.toThrow();
  });

  it('is refused with subject keys (they already seal locally)', () => {
    const { subjects } = memorySubjectKeys();
    expect(() =>
      collaborationCodec({ subjects, subject: () => 'x', envelope: true } as never),
    ).toThrow(TypeError);
  });
});

describe('collaborationCodec: stack descriptor', () => {
  it('describes the crypto server for telescope', () => {
    const { subjects } = memorySubjectKeys();
    expect((etNewCodec(subjects) as unknown as Record<symbol, unknown>)[STACK]).toEqual([
      { tech: 'kms', label: 'agora-crypto', purpose: 'collaboration documents' },
    ]);
  });
});

describe('collaborationCodec: no runtime dependency', () => {
  it('imports neither @adonis-agora/crypto nor @adonis-agora/collaboration at runtime', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/collaboration.ts', import.meta.url), 'utf8');
    const runtimeImports = [...source.matchAll(/^import (?!type )[^;]*from '([^']+)'/gm)].map(
      (match) => match[1],
    );
    expect(runtimeImports).toEqual(['node:crypto', './stack.js']);
  });
});
