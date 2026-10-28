import { createFileRoute } from '@tanstack/react-router';
import * as v from 'valibot';
import { TourPage } from '../components/TourPage.tsx';

// The router JSON-parses search values, so a commit like `7067545` arrives as a number.
const text = v.pipe(v.union([v.string(), v.number()]), v.transform(String));
const SearchSchema = v.object({ repo: text, target: v.optional(text, '') });

export const Route = createFileRoute('/local')({
  validateSearch: (search) => v.parse(SearchSchema, search),
  component: LocalTour,
});

function LocalTour() {
  const { repo, target } = Route.useSearch();
  return <TourPage key={`${repo}@${target}`} sourceRef={{ kind: 'local', repo, target }} />;
}
