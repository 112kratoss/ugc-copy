import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SENTINEL_TYPES,
  buildReport,
  checkConfiguration,
  classStatus,
  collectExpoReflectedTypes,
  diffReports,
  findKotlinTypes,
  obfuscationShare,
  parseMapping,
  parseSeeds,
  parseUsage,
  readOutputs,
} from '../scripts/inspect-r8-output.mjs';

const projectRoot = path.resolve(__dirname, '..');

const MAPPING = `# compiler: R8
# compiler_version: 8.12.0
# min_api: 24
expo.modules.securestore.SecureStoreOptions -> expo.modules.securestore.SecureStoreOptions:
    java.lang.String keychainService -> keychainService
com.example.Foo -> a.b.c:
    1:1:void bar():10:10 -> a
com.example.Nested$Inner -> a.b.d:
kotlin.Metadata -> kotlin.Metadata:
`;

const SEEDS = `expo.modules.securestore.SecureStoreOptions
expo.modules.securestore.SecureStoreOptions: SecureStoreOptions(java.lang.String,boolean)
kotlin.Metadata
`;

const USAGE = `com.example.Gone
com.example.Partial:
    void unused()
    int alsoUnused
expo.modules.image.records.ContentPosition
`;

const CONFIGURATION = `-keepattributes AnnotationDefault,EnclosingMethod,InnerClasses,RuntimeVisibleAnnotations,Signature
-dontoptimize
-keep class * implements expo.modules.kotlin.records.Record {
  *;
}
-keep enum * implements expo.modules.kotlin.types.Enumerable {
  *;
}
-keep class kotlin.Metadata { *; }
-keep class expo.modules.** { *; }
`;

function writeOutputs(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'r8-outputs-'));
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}

/**
 * The plan for widening the R8 shape (docs/android-app-optimization-plan-2026-09-05.md)
 * reads AGP's R8 outputs before any device launch. These pin the parsers to the
 * file formats and the report to the two records that failed in build 62.
 */
describe('inspect-r8-output', () => {
  it('reads class lines from mapping.txt and scores the renamed share', () => {
    const classes = parseMapping(MAPPING);
    expect(classes).toEqual([
      { original: 'expo.modules.securestore.SecureStoreOptions', renamed: 'expo.modules.securestore.SecureStoreOptions' },
      { original: 'com.example.Foo', renamed: 'a.b.c' },
      { original: 'com.example.Nested$Inner', renamed: 'a.b.d' },
      { original: 'kotlin.Metadata', renamed: 'kotlin.Metadata' },
    ]);
    expect(obfuscationShare(classes)).toEqual({ total: 4, renamed: 2, share: 0.5 });
    expect(obfuscationShare([])).toEqual({ total: 0, renamed: 0, share: 0 });
  });

  it('separates kept classes from kept members in seeds.txt', () => {
    const seeds = parseSeeds(SEEDS);
    expect([...seeds.classes]).toEqual(['expo.modules.securestore.SecureStoreOptions', 'kotlin.Metadata']);
    expect(seeds.members.get('expo.modules.securestore.SecureStoreOptions')).toEqual([
      'SecureStoreOptions(java.lang.String,boolean)',
    ]);
  });

  it('separates removed classes from partially shrunk ones in usage.txt', () => {
    const usage = parseUsage(USAGE);
    expect([...usage.removedClasses]).toEqual(['com.example.Gone', 'expo.modules.image.records.ContentPosition']);
    expect(usage.removedMembers.get('com.example.Partial')).toEqual(['void unused()', 'int alsoUnused']);
  });

  it('reads the rules the app relies on from the merged configuration', () => {
    expect(checkConfiguration(CONFIGURATION)).toEqual({
      recordsKept: true,
      enumerablesKept: true,
      kotlinMetadataKept: true,
      blanketExpoKeep: true,
      dontoptimize: true,
      dontobfuscate: false,
      dontshrink: false,
      allowaccessmodification: false,
      repackageclasses: false,
      keepattributes: ['AnnotationDefault', 'EnclosingMethod', 'InnerClasses', 'RuntimeVisibleAnnotations', 'Signature'],
    });
    expect(checkConfiguration('-allowaccessmodification\n-repackageclasses\n').dontoptimize).toBe(false);
  });

  it('finds Kotlin classes with their supertypes, nested ones as Outer$Inner', () => {
    const source = `package expo.modules.example

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.types.Enumerable

// a class mentioned in a comment is not a declaration
class Options(
  @Field val keychainService: String = "class",
  @Field val callback: (Int) -> Unit = {}
) : Record

data class Position(@Field val top: Double? = null) : Record, java.io.Serializable {
  class Inner(@Field val x: Int = 0) : Record
  enum class Mode(val value: String) : Enumerable { A("a"), B("b") }
  fun describe() = Mode::class.java.simpleName
}

enum class Mood : Enumerable { HAPPY }

class Trait<InputType> @PublishedApi internal constructor(
  val exportImpl: (Int) -> Unit
) : Base<InputType> {
  companion object {
    data class Defaults(@Field val compression: Int = 100) : Record
  }
  object Named : Base() {
    class Deep : Record
  }
}

class Plain
`;
    expect(findKotlinTypes(source)).toEqual([
      { name: 'Options', kind: 'class', supertypes: 'Record' },
      { name: 'Position', kind: 'class', supertypes: 'Record, java.io.Serializable' },
      { name: 'Position$Inner', kind: 'class', supertypes: 'Record' },
      { name: 'Position$Mode', kind: 'enum', supertypes: 'Enumerable' },
      { name: 'Mood', kind: 'enum', supertypes: 'Enumerable' },
      { name: 'Trait', kind: 'class', supertypes: 'Base<InputType>' },
      { name: 'Trait$Companion', kind: 'object', supertypes: '' },
      { name: 'Trait$Companion$Defaults', kind: 'class', supertypes: 'Record' },
      { name: 'Trait$Named', kind: 'object', supertypes: 'Base()' },
      { name: 'Trait$Named$Deep', kind: 'class', supertypes: 'Record' },
      { name: 'Plain', kind: 'class', supertypes: '' },
    ]);
  });

  it('collects the records and enumerables the installed Expo modules convert by reflection', () => {
    const types = collectExpoReflectedTypes(projectRoot);
    const names = types.map((type) => type.name);

    // The two records that failed in build 62 must always be on the list, and
    // the scanner must see nested declarations the way mapping.txt spells them.
    expect(names).toContain('expo.modules.securestore.SecureStoreOptions');
    expect(names).toContain('expo.modules.image.records.ContentPosition');
    expect(types.find((type) => type.name === 'expo.modules.securestore.SecureStoreOptions')?.kind).toBe('record');
    expect(names.some((name) => name.includes('$'))).toBe(true);
    // A record declared inside a companion object is spelled through it.
    expect(names).toContain('expo.modules.kotlin.traits.SavableTrait$Companion$SavableBitmapOptions');
    expect(types.filter((type) => type.kind === 'enumerable').length).toBeGreaterThan(0);
    expect(types.length).toBeGreaterThan(50);
  });

  it('reports kept, renamed, removed and missing classes and fails on a lost sentinel', () => {
    const dir = writeOutputs({
      'mapping.txt': MAPPING,
      'seeds.txt': SEEDS,
      'usage.txt': USAGE,
      'configuration.txt': CONFIGURATION,
    });
    const outputs = readOutputs(dir);

    expect(classStatus('expo.modules.securestore.SecureStoreOptions', outputs)).toEqual({ status: 'kept-by-name' });
    expect(classStatus('com.example.Foo', outputs)).toEqual({ status: 'renamed', renamed: 'a.b.c' });
    expect(classStatus('com.example.Gone', outputs)).toEqual({ status: 'removed' });
    expect(classStatus('com.example.Unknown', outputs)).toEqual({ status: 'missing' });

    const report = buildReport(outputs, [
      { name: 'com.example.Nested.Inner', kind: 'record', package: 'example', file: 'x.kt' },
      { name: 'com.example.Gone', kind: 'enumerable', package: 'example', file: 'y.kt' },
    ]);
    expect(report.share.share).toBe(0.5);
    expect(report.survivors.map((survivor) => [survivor.name, survivor.status])).toEqual([
      ['expo.modules.securestore.SecureStoreOptions', 'kept-by-name'],
      ['expo.modules.image.records.ContentPosition', 'removed'],
      ['kotlin.Metadata', 'kept-by-name'],
      // A scanner miss on nesting resolves to the `$` spelling in the same package.
      ['com.example.Nested.Inner', 'renamed'],
      ['com.example.Gone', 'removed'],
    ]);
    expect(report.failures).toEqual([
      'expo.modules.image.records.ContentPosition: removed',
      'com.example.Gone: removed',
    ]);
    expect(report.expoClasses).toEqual({
      'expo.modules.securestore.SecureStoreOptions': 'kept-by-name',
      'expo.modules.image.records.ContentPosition': 'removed',
    });
    expect(SENTINEL_TYPES).toHaveLength(3);
  });

  it('diffs two builds by expo.modules.* status and configuration flags', () => {
    const before = buildReport(
      readOutputs(writeOutputs({ 'mapping.txt': MAPPING, 'usage.txt': USAGE, 'configuration.txt': CONFIGURATION })),
      []
    );
    const after = buildReport(
      readOutputs(
        writeOutputs({
          'mapping.txt': MAPPING.replace(
            'expo.modules.securestore.SecureStoreOptions -> expo.modules.securestore.SecureStoreOptions:',
            'expo.modules.securestore.SecureStoreOptions -> a.b.e:'
          ),
          'usage.txt': 'com.example.Gone\n',
          'configuration.txt': CONFIGURATION.replace('-dontoptimize\n', '-allowaccessmodification\n'),
        })
      ),
      []
    );
    const diff = diffReports(before, after);
    expect(diff.changed).toEqual([
      { name: 'expo.modules.image.records.ContentPosition', from: 'removed', to: 'absent' },
      { name: 'expo.modules.securestore.SecureStoreOptions', from: 'kept-by-name', to: 'renamed' },
    ]);
    expect(diff.configurationChanges.map((change) => change.key).sort()).toEqual(['allowaccessmodification', 'dontoptimize']);
    expect(diff.survivorChanges).toEqual([
      { name: 'expo.modules.securestore.SecureStoreOptions', from: 'kept-by-name', to: 'renamed' },
      { name: 'expo.modules.image.records.ContentPosition', from: 'removed', to: 'missing' },
    ]);
  });
});
