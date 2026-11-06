import { FindingsTable, Headline } from "@/components/report-view";
import { demoReportFixture } from "@/fixtures/report";

// Placeholder wiring: renders the fixture until @ghostkey/core's scanner lands.
export function ScanPage() {
  return (
    <div className="space-y-6">
      <Headline report={demoReportFixture} />
      <FindingsTable report={demoReportFixture} />
    </div>
  );
}
