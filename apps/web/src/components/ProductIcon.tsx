import { Coffee, Cookie, Package, Milk, Amphora, Croissant, Wine, BottleWine, type LucideProps } from "lucide-react";
import { productIconKeySchema } from "@pos/shared";

const icons = { coffee: Coffee, "bottle-water": BottleWine, cookie: Cookie, package: Package, milk: Milk, jar: Amphora, bread: Croissant, bottle: Wine };

export function ProductIcon({ iconKey, ...props }: LucideProps & { iconKey?: string | null }) {
  const parsed = productIconKeySchema.safeParse(iconKey);
  const Icon = icons[parsed.success ? parsed.data : "package"];
  return <Icon size={16} aria-hidden="true" {...props} />;
}
