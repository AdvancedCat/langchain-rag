import { describe, it, expect } from 'vitest';
import { detectDocType } from '../detect.js';

// magic bytes 内联 fixture（plan §2.6 步骤 2）
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const GIF_MAGIC = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

describe('detectDocType priority order', () => {
    it('declaredType wins over all other signals', () => {
        const result = detectDocType({
            declaredType: 'markdown',
            filename: 'doc.txt',
            text: '<!doctype html>',
            bytes: PDF_MAGIC,
        });
        expect(result).toMatchObject({ docType: 'markdown', via: 'declared' });
    });

    it('ignores an unknown declaredType and falls through', () => {
        const result = detectDocType({ declaredType: 'docx', filename: 'doc.md' });
        expect(result).toMatchObject({ docType: 'markdown', via: 'filename' });
    });

    it('magic bytes beat filename', () => {
        const result = detectDocType({ filename: 'photo.png', bytes: PDF_MAGIC });
        expect(result).toMatchObject({ docType: 'pdf', via: 'magic' });
    });

    it('filename beats text sniffing', () => {
        const result = detectDocType({ filename: 'notes.txt', text: '# looks like markdown' });
        expect(result).toMatchObject({ docType: 'plaintext', via: 'filename' });
    });
});

describe('detectDocType magic bytes', () => {
    it.each([
        [PDF_MAGIC, 'pdf'],
        [PNG_MAGIC, 'image'],
        [JPEG_MAGIC, 'image'],
        [GIF_MAGIC, 'image'],
    ] as const)('recognizes binary signatures (%#)', (bytes, expected) => {
        expect(detectDocType({ bytes })).toMatchObject({ docType: expected, via: 'magic' });
    });

    it('also detects %PDF at the start of fetched text', () => {
        expect(detectDocType({ text: '%PDF-1.7 ...' })).toMatchObject({ docType: 'pdf' });
    });
});

describe('detectDocType text sniffing', () => {
    it('detects html doctype and <html> tags case-insensitively', () => {
        expect(detectDocType({ text: '<!DOCTYPE html><html>' })).toMatchObject({
            docType: 'html',
            via: 'sniff',
        });
        expect(detectDocType({ text: '<html lang="en">' })).toMatchObject({ docType: 'html' });
    });

    it('detects markdown via ATX headers', () => {
        expect(detectDocType({ text: 'intro\n\n## Installation\nrun npm' })).toMatchObject({
            docType: 'markdown',
            via: 'sniff',
        });
    });

    it('detects markdown via code fences', () => {
        expect(detectDocType({ text: 'example:\n```ts\nconst x = 1;\n```' })).toMatchObject({
            docType: 'markdown',
        });
    });

    it('falls back to plaintext with a warning when nothing matches', () => {
        const result = detectDocType({ text: 'just plain words, nothing special' });
        expect(result.docType).toBe('plaintext');
        expect(result.via).toBe('fallback');
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].code).toBe('type-detection-fallback');
    });
});
