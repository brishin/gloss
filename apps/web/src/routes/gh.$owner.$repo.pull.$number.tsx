import { createFileRoute } from '@tanstack/react-router';
import * as v from 'valibot';
import { TourPage } from '../components/TourPage.tsx';
import { tourPositionSearch } from '../lib/source-routes.tsx';

const SearchSchema = v.object(tourPositionSearch);

export const Route = createFileRoute('/gh/$owner/$repo/pull/$number')({
  validateSearch: (search) => v.parse(SearchSchema, search),
  component: GithubTour,
});

function GithubTour() {
  const { owner, repo, number } = Route.useParams();
  const ref = { kind: 'github-pr' as const, owner, repo, number: Number(number) };
  return <TourPage key={`${owner}/${repo}#${number}`} sourceRef={ref} />;
}
