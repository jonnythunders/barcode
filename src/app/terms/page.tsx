import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — Barcode Kestrel",
  description: "Terms of Service for Barcode Kestrel brand intelligence platform.",
};

export default function TermsPage() {
  const effective = "May 26, 2026";
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-3xl mx-auto px-6 py-16">
        {/* Header */}
        <div className="mb-10 pb-6 border-b border-slate-200">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-700 mb-2">Legal</p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Terms of Service</h1>
          <p className="text-sm text-slate-500 mt-2">Effective date: {effective}</p>
        </div>

        <div className="prose prose-slate max-w-none space-y-8 text-[15px] leading-relaxed text-slate-700">

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">1. Overview</h2>
            <p>
              These Terms of Service (&ldquo;Terms&rdquo;) govern access to and use of Barcode Kestrel
              (the &ldquo;Service&rdquo;), a brand intelligence and prospecting platform operated by
              Jon Piepho (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;). By accessing or
              using the Service, you agree to be bound by these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">2. Use of the Service</h2>
            <p>
              Barcode Kestrel is a professional analytics tool designed for internal business use
              by authorized organizations. Access is granted on an invitation-only basis. You agree to:
            </p>
            <ul className="list-disc pl-6 mt-3 space-y-2">
              <li>Use the Service solely for your organization&rsquo;s internal business purposes</li>
              <li>Keep your login credentials confidential and not share access with unauthorized parties</li>
              <li>Not attempt to reverse engineer, copy, or reproduce any part of the platform</li>
              <li>Not use the Service for any unlawful purpose or in violation of applicable regulations</li>
              <li>Comply with the terms of any applicable pilot or service agreement with us</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">3. Data and Third-Party Sources</h2>
            <p>
              The Service aggregates and analyzes data from publicly available sources including
              Amazon product listings, social media platforms (TikTok, Instagram), Google Trends,
              Reddit, and retail scan data you upload. We do not guarantee the accuracy, completeness,
              or timeliness of any third-party data. Brand intelligence outputs are intended as
              directional signals for research purposes and should not be the sole basis for
              business decisions.
            </p>
            <p className="mt-3">
              Data you upload to the Service (including Nielsen or other retail scan data) remains
              your property. We use it solely to provide the Service to you and do not share it
              with third parties.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">4. Intellectual Property</h2>
            <p>
              All aspects of the Barcode Kestrel platform — including the codebase, algorithms,
              scoring methodology, user interface, and brand prospecting framework — are the exclusive
              intellectual property of Jon Piepho. Your use of the Service does not grant you any
              ownership interest in the platform or any component thereof.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">5. AI-Generated Content</h2>
            <p>
              Barcode Kestrel uses artificial intelligence to generate brand summaries, momentum
              scores, and analyst commentary. These outputs are automated and may contain errors or
              omissions. They are provided for informational purposes only and do not constitute
              investment advice, legal advice, or professional recommendations of any kind.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">6. Disclaimer of Warranties</h2>
            <p>
              THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR
              IMPLIED. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR
              THAT ANY PARTICULAR RESULT WILL BE ACHIEVED THROUGH ITS USE.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">7. Limitation of Liability</h2>
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, OUR TOTAL LIABILITY ARISING FROM YOUR USE
              OF THE SERVICE SHALL NOT EXCEED THE FEES PAID BY YOU IN THE THREE MONTHS PRECEDING
              THE CLAIM. IN NO EVENT WILL WE BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL,
              CONSEQUENTIAL, OR PUNITIVE DAMAGES.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">8. Changes to These Terms</h2>
            <p>
              We may update these Terms from time to time. We will notify you of material changes
              via email or in-app notice. Continued use of the Service after notice of changes
              constitutes acceptance of the updated Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">9. Governing Law</h2>
            <p>
              These Terms are governed by the laws of the State of Minnesota, without regard to
              conflict of laws principles.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">10. Contact</h2>
            <p>
              Questions about these Terms may be directed to:{" "}
              <a href="mailto:jon@youngproducts.ai" className="text-teal-700 underline">
                jon@youngproducts.ai
              </a>
            </p>
          </section>

        </div>
      </div>
    </div>
  );
}
