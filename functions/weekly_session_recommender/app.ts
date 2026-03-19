import { ScheduledEvent } from 'aws-lambda';
import { runPendingRecommendationReminders, runWeeklySessionRecommender } from './src/recommender.handler';

export const lambdaHandler = async (event: ScheduledEvent): Promise<void> => {
    console.log('Weekly session recommender invoked', JSON.stringify(event));
    await runWeeklySessionRecommender();
};

export const reminderLambdaHandler = async (event: ScheduledEvent): Promise<void> => {
    console.log('Session recommendation reminder invoked', JSON.stringify(event));
    await runPendingRecommendationReminders();
};
