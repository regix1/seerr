import type FileFlowsAPI from '@server/api/fileflows';

/** FileFlows `FileStatus` values from the OpenAPI schema. */
export enum FileFlowsFileStatus {
  Disabled = -3,
  Aborted = -2,
  Failed = -1,
  Unprocessed = 0,
  Processed = 1,
  Processing = 2,
  OnHold = 4,
}

export const FILE_FLOWS_EMPTY_FLOW_UID = '00000000-0000-0000-0000-000000000000';

export class FileFlowsModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileFlowsModelError';
  }
}

export interface FileFlowsObjectReference {
  Uid: string;
  Name: string;
}

/** Raw `/api/status` processing file row. */
export interface FileFlowsProcessingFileDto {
  name: string;
  relativePath?: string;
  library?: string;
  step?: string;
  stepPercent?: number;
}

export interface FileFlowsStatusDto {
  queue: number;
  processing: number;
  processingFiles: FileFlowsProcessingFileDto[];
}

export interface FileFlowsExecutedNodeDto {
  NodeName?: string;
}

/** Raw `/api/library-file/{uid}` record. */
export interface FileFlowsLibraryFileDto {
  Uid: string;
  Name: string;
  FlowUid?: string;
  FlowName?: string;
  LibraryUid?: string;
  LibraryName?: string;
  ExecutedNodes?: FileFlowsExecutedNodeDto[];
}

/** Raw `/api/library/{uid}` record (fields used by Seerr). */
export interface FileFlowsLibraryDto {
  Uid: string;
  Name?: string;
  Flow?: FileFlowsObjectReference;
}

/** Raw search row — FileFlows abbreviates field names in list responses. */
export interface FileFlowsLibraryFileSearchRowDto {
  u?: string;
  Uid?: string;
  fu?: string;
  FlowUid?: string;
}

export interface FileFlowsLibraryFileSearchQuery {
  Status: FileFlowsFileStatus;
  Library: string;
  Limit: number;
}

/** Normalized search hit — always has a library-file uid. */
export interface FileFlowsLibraryFileSearchHit {
  uid: string;
  flowUid: string | null;
}

/** Step total for a library's assigned flow, sampled from a processed file. */
export interface FileFlowsFlowStepTotal {
  libraryUid: string;
  flowUid: string;
  stepTotal: number;
}

/**
 * Everything required to render one overall 0→100 FileFlows badge percent for
 * an actively processing file. Built only when the API returns complete data.
 */
export interface FileFlowsProcessingSnapshot {
  fileBasename: string;
  libraryUid: string;
  flowUid: string;
  executedNodeCount: number;
  currentStepPercent: number | null;
  stepTotal: number;
  overallPercent: number;
}

export function normalizeSearchRow(
  row: FileFlowsLibraryFileSearchRowDto | undefined
): FileFlowsLibraryFileSearchHit | null {
  if (!row) {
    return null;
  }
  const uid = row.u ?? row.Uid;
  if (!uid) {
    return null;
  }
  const rawFlowUid = row.fu ?? row.FlowUid ?? null;
  const flowUid =
    rawFlowUid && rawFlowUid !== FILE_FLOWS_EMPTY_FLOW_UID ? rawFlowUid : null;
  return { uid, flowUid };
}

export function resolveFlowUid(
  library: FileFlowsLibraryDto,
  sample?: FileFlowsLibraryFileDto
): string {
  const fromSample = sample?.FlowUid;
  if (fromSample && fromSample !== FILE_FLOWS_EMPTY_FLOW_UID) {
    return fromSample;
  }
  const fromLibrary = library.Flow?.Uid;
  if (fromLibrary && fromLibrary !== FILE_FLOWS_EMPTY_FLOW_UID) {
    return fromLibrary;
  }
  throw new FileFlowsModelError(
    `Library ${library.Uid} (${library.Name ?? 'unnamed'}) has no flow assigned`
  );
}

/**
 * Pull the flow step total for a library from FileFlows: one processed file in
 * the same library, using ExecutedNodes.length (not the flow graph Part count).
 */
export async function resolveFileFlowsFlowStepTotal(
  api: FileFlowsAPI,
  libraryUid: string
): Promise<FileFlowsFlowStepTotal> {
  const library = await api.getLibrary(libraryUid);
  const rows = await api.searchLibraryFiles({
    Status: FileFlowsFileStatus.Processed,
    Library: libraryUid,
    Limit: 1,
  });
  const hit = normalizeSearchRow(rows[0]);
  if (!hit) {
    throw new FileFlowsModelError(
      `No processed library file found to sample step total for library ${libraryUid}`
    );
  }
  const sample = await api.getLibraryFile(hit.uid);
  const stepTotal = sample.ExecutedNodes?.length ?? 0;
  if (stepTotal <= 0) {
    throw new FileFlowsModelError(
      `Processed sample ${hit.uid} returned no ExecutedNodes for library ${libraryUid}`
    );
  }
  const flowUid = resolveFlowUid(library, sample);
  return { libraryUid, flowUid, stepTotal };
}

export function clampFileFlowsPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Map FileFlows per-node stepPercent to a single 0→100 flow percent. */
export function computeFileFlowsOverallPercent(
  executedNodeCount: number,
  currentStepPercent: number | null | undefined,
  stepTotal: FileFlowsFlowStepTotal
): number {
  const nodeFraction =
    typeof currentStepPercent === 'number' &&
    Number.isFinite(currentStepPercent)
      ? currentStepPercent / 100
      : 0;
  const total = Math.max(stepTotal.stepTotal, executedNodeCount + 1);
  return clampFileFlowsPercent(
    ((executedNodeCount + nodeFraction) / total) * 100
  );
}

export function buildFileFlowsProcessingSnapshot(input: {
  fileBasename: string;
  detail: FileFlowsLibraryFileDto;
  statusFile: FileFlowsProcessingFileDto;
  stepTotal: FileFlowsFlowStepTotal;
  previousOverallPercent?: number;
}): FileFlowsProcessingSnapshot {
  const libraryUid = input.detail.LibraryUid;
  if (!libraryUid) {
    throw new FileFlowsModelError(
      `Library file ${input.detail.Uid} is missing LibraryUid`
    );
  }
  if (libraryUid !== input.stepTotal.libraryUid) {
    throw new FileFlowsModelError(
      `Library uid mismatch for ${input.fileBasename}: detail=${libraryUid} total=${input.stepTotal.libraryUid}`
    );
  }

  const executedNodeCount = input.detail.ExecutedNodes?.length ?? 0;
  const currentStepPercent =
    typeof input.statusFile.stepPercent === 'number' &&
    Number.isFinite(input.statusFile.stepPercent)
      ? input.statusFile.stepPercent
      : null;

  const rawOverall = computeFileFlowsOverallPercent(
    executedNodeCount,
    currentStepPercent,
    input.stepTotal
  );
  const overallPercent = Math.max(
    input.previousOverallPercent ?? 0,
    rawOverall
  );

  return {
    fileBasename: input.fileBasename,
    libraryUid,
    flowUid: input.stepTotal.flowUid,
    executedNodeCount,
    currentStepPercent,
    stepTotal: input.stepTotal.stepTotal,
    overallPercent,
  };
}
