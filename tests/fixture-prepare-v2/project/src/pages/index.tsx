import { fromA } from "parent-a";
import { fromB } from "parent-b";
import Card from "hoisted-components";
import data from "format-pkg";
import virtualA from "virtual:a";
import slash from "virtual:a/b";
import question from "virtual:a?b";
import absolute from "virtual:absolute";
import condition from "worker-conditions";

export default function Page() {
  return <main>{fromA}{fromB}{String(Card)}{String(data)}{virtualA}{slash}{question}{absolute}{condition}</main>;
}
