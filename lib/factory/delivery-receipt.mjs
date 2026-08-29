export const DELIVERY_RECEIPT_SCHEMA = 'dotagents.factory-delivery-receipt.v1';

export function assertDeliveryReceipt({ report, priorReportId, receipt, batchToken }) {
  if (!report || report.schema_version !== '8.0' || typeof report.report_id !== 'string' || report.report_id === priorReportId) throw new Error('fresh_report_required');
  if (!receipt || receipt.schema !== DELIVERY_RECEIPT_SCHEMA || receipt.report_id !== report.report_id || receipt.batch_token !== batchToken) throw new Error('delivery_receipt_mismatch');
  return true;
}
