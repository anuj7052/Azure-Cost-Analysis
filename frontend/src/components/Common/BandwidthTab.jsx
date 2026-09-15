import BandwidthReport from '../../pages/Bandwidth';
import BandwidthCostPanel from './BandwidthCostPanel';

/**
 * The Cost Explorer's Bandwidth tab: volumes first, then the charge behind them.
 *
 * It exists as one module so the whole tab — the report, the cost panel, the
 * meter tables and the resource tracking — is a single lazy chunk. Nothing here
 * is needed by the trend or resource-group tabs, and it is a third of what the
 * explorer used to download before showing its first chart.
 */
export default function BandwidthTab({ resetKey }) {
  return (
    <div className="space-y-5">
      <BandwidthReport embedded />
      <BandwidthCostPanel key={resetKey} />
    </div>
  );
}
