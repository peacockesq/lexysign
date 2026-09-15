/**
 * Provisioning artifact only. Do not run against live Mongo from the MCP worker.
 *
 * Unique indexes required before activating lexysignFirmSendInvitations:
 *   - lexysign_FirmSendReservation.documentId unique
 *   - lexysign_FirmSendReservation.approvalId unique sparse
 *
 * Parent enrolls LEXYSIGN_FIRM_APPROVAL_SECRET after review. This file is the
 * explicit schema/index gate; live database work is out of scope here.
 */
const CLASS_NAME = 'lexysign_FirmSendReservation';
const INDEXES = [
  {
    name: 'lexysign_firm_send_documentId_unique',
    spec: { documentId: 1 },
    options: { unique: true },
  },
  {
    name: 'lexysign_firm_send_approvalId_unique',
    spec: { approvalId: 1 },
    options: { unique: true, sparse: true },
  },
];

export function firmSendReservationIndexPlan() {
  return {
    className: CLASS_NAME,
    indexes: INDEXES,
    liveExecution: false,
    env: ['LEXYSIGN_FIRM_APPROVAL_SECRET'],
  };
}

export default async function createFirmSendReservationIndex() {
  throw new Error(
    'GATE: createFirmSendReservationIndex must not be executed by the MCP worker. Parent applies this unique-index plan after review.'
  );
}
