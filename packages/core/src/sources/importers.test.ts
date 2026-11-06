import type { FileChange } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import {
  bumpedPackages,
  fileImportQuery,
  importQueries,
  importsQueryPath,
  isImportLine,
  packageImportQuery,
} from './importers.ts';

const file = (path: string, patch = '', status: FileChange['status'] = 'modified'): FileChange => ({
  id: path,
  path,
  status,
  additions: patch.split('\n').length,
  deletions: 0,
  isBinary: false,
  truncated: false,
  hunks: patch ? [{ id: 'h', header: '@@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, patch }] : [],
});

describe('fileImportQuery', () => {
  it('finds script imports by module name, an index by its folder', () => {
    const query = fileImportQuery('ts/web/src/editor/RichTextEditorSession.ts')!;
    expect(isImportLine("import { RichTextEditorSession } from '../editor/RichTextEditorSession';", query)).toBe(true);
    expect(isImportLine('const session = new RichTextEditorSession();', query)).toBe(false);
    expect(fileImportQuery('ts/web/src/lightbox/index.tsx')?.term).toBe('lightbox');
    expect(fileImportQuery('a/Button.web.tsx')?.term).toBe('Button');
  });

  it('finds Python imports by package and module', () => {
    const query = fileImportQuery('app/services/plain.py')!;
    expect(isImportLine('from app.services.plain import send_new_email', query)).toBe(true);
    expect(isImportLine('from app.services import plain', query)).toBe(true);
    expect(isImportLine('plain = 1  # from somewhere', query)).toBe(false);
  });

  it('skips files nothing imports by path', () => {
    expect(fileImportQuery('ios/Recorder.swift')).toBeUndefined();
    expect(fileImportQuery('web/a.ts')).toBeUndefined();
  });
});

describe('bumpedPackages', () => {
  it('lists dependencies a package.json adds or changes, not its own fields', () => {
    const manifest = file(
      'packages/shared-data/package.json',
      ' {\n-  "version": "1.0.0",\n+  "version": "1.1.0",\n-    "prosemirror-model": "^1.19.0",\n+    "prosemirror-model": "^1.22.1",\n+    "@scope/ui": "workspace:*",',
    );
    expect(bumpedPackages([manifest, file('src/a.ts', '+const x = "1.0";')])).toEqual([
      'prosemirror-model',
      '@scope/ui',
    ]);
    const query = packageImportQuery('prosemirror-model');
    expect(isImportLine("import { Schema } from 'prosemirror-model';", query)).toBe(true);
    expect(isImportLine("import x from 'prosemirror-model-extra';", query)).toBe(false);
  });
});

describe('importQueries', () => {
  it('asks about bumped packages first, then the largest changed shared files, never tests or new files', () => {
    const queries = importQueries(
      [
        file('web/src/small.ts', '+a'),
        file('web/src/big.ts', '+a\n+b\n+c'),
        file('web/src/new.ts', '+a\n+b\n+c\n+d', 'added'),
        file('web/src/big.test.ts', '+a\n+b\n+c\n+d\n+e'),
        file('package.json', '+    "left-pad": "^2.0.0",'),
      ],
      3,
    );
    expect(queries.map((query) => query.label)).toEqual(['package left-pad', 'web/src/big.ts', 'web/src/small.ts']);
  });
});

describe('importsQueryPath', () => {
  const query = fileImportQuery('ts/ts-web/src/editor/RichTextEditor.tsx')!;
  it('keeps imports that point at the file, relative or aliased', () => {
    const relative = "import { RichTextEditor } from '../editor/RichTextEditor';";
    expect(importsQueryPath('ts/ts-web/src/lightbox/CaptureEditorLightbox.tsx', relative, query)).toBe(true);
    expect(importsQueryPath('ts/ts-web/src/a/B.tsx', "import { X } from '@/editor/RichTextEditor';", query)).toBe(true);
  });
  it('drops a namesake in another folder or app', () => {
    const mobile = "import { RichTextEditor } from '@/components/RichTextEditor';";
    expect(importsQueryPath('Apps/FlashbackMobile/src/CaptureEditorSheet.tsx', mobile, query)).toBe(false);
    const sibling = "import { X } from '../components/RichTextEditor';";
    expect(importsQueryPath('ts/ts-web/src/a/B.tsx', sibling, query)).toBe(false);
  });
  it('resolves relative Python imports against the importer, and passes absolute ones', () => {
    const query = fileImportQuery('app/services/plain.py')!;
    const own = 'from .plain import send_email';
    expect(isImportLine(own, query)).toBe(true);
    expect(importsQueryPath('app/services/mail.py', own, query)).toBe(true);
    expect(importsQueryPath('app/other/mail.py', own, query)).toBe(false);
    const sibling = 'from . import plain';
    expect(isImportLine(sibling, query)).toBe(true);
    expect(importsQueryPath('app/services/mail.py', sibling, query)).toBe(true);
    expect(importsQueryPath('app/api/routes.py', 'from ..services.plain import x', query)).toBe(true);
    expect(importsQueryPath('app/api/routes.py', 'from ..services import plain', query)).toBe(true);
    expect(importsQueryPath('app/jobs.py', 'from app.services.plain import send_email', query)).toBe(true);
    expect(importsQueryPath('app/jobs.py', 'from app.services import plain', query)).toBe(true);
    expect(importsQueryPath('app/jobs.py', 'from app.other import plain', query)).toBe(false);
    expect(importsQueryPath('app/jobs.py', 'import plaintext', query)).toBe(false);
    for (const line of [
      'from app.services import helper, plain',
      'from . import helper, plain',
      'from app.services import (plain, helper)',
    ]) {
      expect(isImportLine(line, query)).toBe(true);
    }
    expect(importsQueryPath('app/jobs.py', 'from app.services import helper, plain', query)).toBe(true);
    expect(importsQueryPath('app/services/mail.py', 'from . import helper, plain', query)).toBe(true);
    expect(importsQueryPath('app/jobs.py', 'from app.services import (plain, helper)', query)).toBe(true);
    expect(importsQueryPath('app/jobs.py', 'from app.other import helper, plain', query)).toBe(false);
  });

  it('resolves an index file by its folder, and passes packages', () => {
    const index = fileImportQuery('web/src/lightbox/index.ts')!;
    expect(importsQueryPath('web/src/pages/Page.tsx', "import { Lightbox } from '../lightbox';", index)).toBe(true);
    // Directly run TypeScript names the index file in full.
    const barrel = fileImportQuery('packages/core/src/sources/index.ts')!;
    const line = "export * from './sources/index.ts';";
    expect(isImportLine(line, barrel)).toBe(true);
    expect(importsQueryPath('packages/core/src/index.ts', line, barrel)).toBe(true);
    const pkg = packageImportQuery('prosemirror-model');
    expect(importsQueryPath('x.ts', "import { Schema } from 'prosemirror-model';", pkg)).toBe(true);
  });
});

describe('importQueries for namesakes', () => {
  it('looks up each changed file of the same name', () => {
    const queries = importQueries([file('mobile/Button.ts', '+a'), file('web/Button.ts', '+a')], 10);
    expect(queries.map((query) => query.label)).toEqual(['mobile/Button.ts', 'web/Button.ts']);
  });
});
