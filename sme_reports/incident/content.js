// Hand-written, per-incident prose that the data cannot produce: the
// working hypothesis and the steps we are taking. Keyed by system id; a
// system with no entry renders the report without those sections. The
// hypothesis's supporting facts are generated (timeline.js), not written.
module.exports = {
  SME21284: {
    hypothesis: {
      title: "SME21284 event, Oct 9–11: working hypothesis",
      body: [
        "The scan room appears to have lost power or been powered down. This took down the HHM (Hospital Host Machine) and the GE Magmon, and affected some networking equipment. Three separate devices are involved, the HHM, the Magmon and Avante’s MMB (Magnet Monitor Box), which makes the exact sequence harder to trace. The MMB stayed online, and our platform kept communicating with it, at least intermittently.",
        "Because the MMB stayed in contact, it never went long enough without communication to trigger MMB Unreachable. It wasn’t delivering usable readings, though. The readings it held reached us later, as a backfill.",
        "Our alert detection analyzes only recent data, by design, so a backfill doesn’t set off a flood of alerts for conditions that have already passed. As a result, the backfilled readings were stored but not analyzed. The compressor-off and rising He pressure conditions went undetected until current readings resumed. We have a few more lines of inquiry we can pursue to confirm the details.",
        "HHM Unreachable triggered as designed, because the HHM itself was offline beyond its 12-hour threshold. We understand this alert can get lost in the flurry of other HHM offline notifications and lose its significance. Going forward, the fix is our new MMB Edge, which handles offline conditions differently, among many other things. It’s a new platform, but it’s already deployed. We’re also running a proof of concept of a power monitoring solution, designed to give better information on events like this one. Given this system’s history of issues, we’d consider adding it to the MMB Edge install here."
      ]
    },
    steps: [
      {
        title: "Aggregate all offline events into a generic Offline alert",
        body:
          "During this event, the system going offline showed up as several different alerts, including HHM Unreachable and Absent/Null Mag Data, each with its own timing and recipients. We will roll every offline event into one Offline alert, so recipients get a single, clear notice that the system has stopped reporting. The more specific offline alerts will continue to be detected and sent as they are today, so no detail is lost."
      }
    ]
  }
};
