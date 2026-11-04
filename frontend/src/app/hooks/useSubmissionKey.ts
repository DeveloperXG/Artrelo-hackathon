import { useState } from 'react';
import { createSubmissionKey } from '../lib/requestWorkflow';

/** One idempotency key per form, stable across renders. */
export function useSubmissionKey(seed?: Parameters<typeof createSubmissionKey>[0]) {
  return useState(() => createSubmissionKey(seed))[0];
}
