import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Barcode Kestrel",
  description: "Privacy Policy for Barcode Kestrel brand intelligence platform.",
};

export default function PrivacyPage() {
  const effective = "May 26, 2026";
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-3xl mx-auto px-6 py-16">
        {/* Header */}
        <div className="mb-10 pb-6 border-b border-slate-200">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-700 mb-2">Legal</p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Privacy Policy</h1>
          <p className="text-sm text-slate-500 mt-2">Effective date: {effective}</p>
        </div>

        <div className="prose prose-slate max-w-none space-y-8 text-[15px] leading-relaxed text-slate-700">

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">1. Who We Are</h2>
            <p>
              Barcode Kestrel is a brand intelligence platform operated by Jon Piepho
              (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;). This Privacy Policy
              explains how we collect, use, and protect information in connection with the Service.
              Questions may be directed to{" "}
              <a href="mailto:jon@youngproducts.ai" className="text-teal-700 underline">
                jon@youngproducts.ai
              </a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">2. Information We Collect</h2>
            <h3 className="text-base font-semibold text-slate-800 mt-4 mb-2">Account Information</h3>
            <p>
              When you are granted access to the Service, we collect your email address and any
              profile information you provide. This is used solely to authenticate your account
              and provide you access to the platform.
            </p>
            <h3 className="text-base font-semibold text-slate-800 mt-4 mb-2">Data You Upload</h3>
            <p>
              You may upload retail scan data (such as Nielsen exports) and other business data
              to the platform. This data remains yours. We use it only to power the brand
              analysis features of the Service and do not share it with any third party.
            </p>
            <h3 className="text-base font-semibold text-slate-800 mt-4 mb-2">Usage Data</h3>
            <p>
              We collect standard usage logs (pages visited, features used, time of access) to
              monitor platform health, diagnose issues, and improve the Service. This data is not
              sold or shared with third parties for marketing purposes.
            </p>
            <h3 className="text-base font-semibold text-slate-800 mt-4 mb-2">Publicly Available Brand Data</h3>
            <p>
              The platform analyzes publicly available information about consumer brands from
              sources including social media platforms, e-commerce sites, and search trend
              services. This analysis pertains to brands as commercial entities, not to
              individual consumers.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">3. How We Use Information</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>To provide, operate, and improve the Service</li>
              <li>To authenticate users and manage access</li>
              <li>To generate brand intelligence outputs and reports</li>
              <li>To respond to support requests or inquiries</li>
              <li>To comply with legal obligations</li>
            </ul>
            <p className="mt-3">
              We do not sell, rent, or trade your personal information or uploaded data to any
              third party.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">4. Third-Party Services</h2>
            <p>
              The Service is built on infrastructure provided by third parties including:
            </p>
            <ul className="list-disc pl-6 mt-3 space-y-2">
              <li><strong>Supabase</strong> — database and authentication hosting</li>
              <li><strong>Vercel</strong> — application hosting and delivery</li>
              <li><strong>Anthropic</strong> — AI-powered analysis features (Barry)</li>
            </ul>
            <p className="mt-3">
              These providers process data solely to deliver the Service and are bound by their
              own privacy and security commitments. Data processed by Anthropic for AI features
              is subject to{" "}
              <a
                href="https://www.anthropic.com/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal-700 underline"
              >
                Anthropic&rsquo;s Privacy Policy
              </a>
              . Social platform data is retrieved via official APIs in accordance with each
              platform&rsquo;s developer terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">5. Data Retention</h2>
            <p>
              Account and usage data is retained for the duration of the service relationship and
              for a reasonable period thereafter for legal and business purposes. Uploaded data
              (such as Nielsen files) may be deleted upon written request. You may request
              deletion of your account data by contacting us at{" "}
              <a href="mailto:jon@youngproducts.ai" className="text-teal-700 underline">
                jon@youngproducts.ai
              </a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">6. Security</h2>
            <p>
              We implement industry-standard technical and organizational measures to protect
              your data, including encrypted connections (HTTPS), authentication controls, and
              access restrictions. No method of transmission or storage is 100% secure, and we
              cannot guarantee absolute security.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">7. Your Rights</h2>
            <p>
              Depending on your location, you may have rights to access, correct, or delete your
              personal data. To exercise these rights, contact us at{" "}
              <a href="mailto:jon@youngproducts.ai" className="text-teal-700 underline">
                jon@youngproducts.ai
              </a>
              . We will respond within a reasonable timeframe.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">8. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. We will notify users of
              material changes via email or in-app notice. Continued use of the Service after
              notice of changes constitutes acceptance of the updated Policy.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">9. Contact</h2>
            <p>
              For privacy-related questions or requests:{" "}
              <a href="mailto:jon@youngproducts.ai" className="text-teal-700 underline">
                jon@youngproducts.ai
              </a>
            </p>
          </section>

        </div>

        {/* Footer links */}
        <div className="mt-12 pt-6 border-t border-slate-200 flex items-center gap-6 text-sm text-slate-500">
          <a href="/terms" className="hover:text-teal-700 transition-colors">Terms of Service</a>
          <a href="/privacy" className="hover:text-teal-700 transition-colors font-medium text-teal-700">Privacy Policy</a>
          <a href="/login" className="hover:text-teal-700 transition-colors">Back to app</a>
        </div>
      </div>
    </div>
  );
}
