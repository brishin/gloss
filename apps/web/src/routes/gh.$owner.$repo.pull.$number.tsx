import { createFileRoute } from '@tanstack/react-router';
import { TourPage } from '../components/TourPage.tsx';

export const Route = createFileRoute('/gh/$owner/$repo/pull/$number')({ component: GithubTour });

function GithubTour() {
  const { owner, repo, number } = Route.useParams();
  const ref = { kind: 'github-pr' as const, owner, repo, number: Number(number) };
  return <TourPage key={`${owner}/${repo}#${number}`} sourceRef={ref} />;
}
