import { LegacyHead } from "./legacy-head";

export const metadata = {
  title: "From metadata",
};

export default function Page() {
  return (
    <main>
      <LegacyHead />
      <h1 id="next-head-ignored">next/head is ignored in the App Router</h1>
    </main>
  );
}
