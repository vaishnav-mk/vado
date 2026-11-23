import { createFileRoute, notFound } from "@tanstack/react-router";
import { DocPage } from "../components/doc-page";
import { docs } from "../content";

const find = (slug: string | undefined) => docs.find((doc) => doc.slug === slug);

export const Route = createFileRoute("/docs/$slug")({
  loader: ({ params }) => {
    const doc = find(params.slug);

    if (doc === undefined) throw notFound();

    return doc.slug;
  },
  head: ({ loaderData }) => {
    const doc = find(loaderData);

    return {
      meta: [
        { title: `${doc?.navTitle ?? doc?.title ?? "Not found"} · vado docs` },
        ...(doc === undefined ? [] : [{ name: "description", content: doc.description }]),
      ],
    };
  },
  component: Page,
});

function Page() {
  const doc = find(Route.useLoaderData());

  if (doc === undefined) throw notFound();

  return <DocPage doc={doc} />;
}
