import { revalidatePath } from "next/cache";
import { markStaticToPartialRevalidated } from "../static-to-partial/state";

export async function POST() {
  markStaticToPartialRevalidated();
  revalidatePath("/partial-prefetching/static-to-partial");
  return Response.json({ revalidated: true });
}
