import type { Metadata } from "next";

import PageBody from "./page-body";

const TITLE = "Teams — the second person on the brain is the product we license | MUON";
const DESCRIPTION =
  "Individual MUON is one person's desk, free under the Individual Use Grant. Teams is Linked Operation: two or more people's instances sharing memory, graphs, crews, claims, or findings — licensed per named person.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function Page() {
  return <PageBody />;
}
