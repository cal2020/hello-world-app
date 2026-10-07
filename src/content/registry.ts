import { STRUCTURE_META, type StructureMeta } from './structures';
import { SCIENCE, type ScienceRecord } from './science';
import { SOURCES } from './sources';
import { GROUP_IDS, type GroupId, type GroupRecord, type SourceRecord, type StructureId, type StructureRecord } from './types';

export const STRUCTURES: StructureRecord[] = STRUCTURE_META.map((meta: StructureMeta) => {
  const science: ScienceRecord = SCIENCE[meta.id];
  return { ...meta, ...science };
});

const byId = new Map<StructureId, StructureRecord>(STRUCTURES.map((s) => [s.id, s]));

export function structure(id: StructureId): StructureRecord {
  const record = byId.get(id);
  if (!record) throw new Error(`Unknown structure ${id}`);
  return record;
}

export const GROUPS: GroupRecord[] = GROUP_IDS.map((id: GroupId) => ({
  id,
  structures: STRUCTURES.filter((s) => s.group === id).map((s) => s.id),
}));

const sourceById = new Map<string, SourceRecord>(SOURCES.map((s) => [s.id, s]));

export function source(id: string): SourceRecord {
  const record = sourceById.get(id);
  if (!record) throw new Error(`Unknown source ${id}`);
  return record;
}

export function hasSource(id: string): boolean {
  return sourceById.has(id);
}

/** Every source id cited anywhere for a structure, in first-cited order. */
export function citedSources(s: StructureRecord): string[] {
  const ordered: string[] = [];
  const add = (ids: string[]) => {
    for (const id of ids) if (!ordered.includes(id)) ordered.push(id);
  };
  add(s.descriptionSources);
  add(s.functionSources);
  add(s.typicalSize.sources);
  add(s.typicalQuantity.sources);
  for (const fact of s.facts) add(fact.sources);
  add(s.interesting.sources);
  return ordered;
}

/** Structures that cite a source (for the grouped source list in Help/About). */
export function structuresCiting(sourceId: string): StructureId[] {
  return STRUCTURES.filter((s) => citedSources(s).includes(sourceId)).map((s) => s.id);
}
