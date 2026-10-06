import { redirect } from "next/navigation";

/** Trading moved to the landing page; old links keep working. */
export default function MarketPage() {
  redirect("/");
}
