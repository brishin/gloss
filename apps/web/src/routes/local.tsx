import { createFileRoute } from '@tanstack/react-router';
import * as v from 'valibot';
import { TourPage } from '../components/TourPage.tsx';
import { searchText, tourPositionSearch } from '../lib/source-routes.tsx';

const SearchSchema = v.object({ repo: searchText, target: v.optional(searchText, ''), ...tourPositionSearch });

export const Route = createFileRoute('/local')({
  validateSearch: (search) => v.parse(SearchSchema, search),
  component: LocalTour,
});

function LocalTour() {
  const { repo, target } = Route.useSearch();
  return <TourPage key={`${repo}@${target}`} sourceRef={{ kind: 'local', repo, target }} />;
}
