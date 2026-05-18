declare module "google-trends-api" {
  interface InterestOverTimeOptions {
    keyword: string | string[];
    startTime?: Date;
    endTime?: Date;
    geo?: string;
    hl?: string;
    timezone?: number;
    category?: number;
    property?: string;
  }

  interface RelatedQueriesOptions {
    keyword: string | string[];
    startTime?: Date;
    endTime?: Date;
    geo?: string;
    hl?: string;
  }

  const googleTrends: {
    interestOverTime(options: InterestOverTimeOptions): Promise<string>;
    relatedQueries(options: RelatedQueriesOptions): Promise<string>;
    relatedTopics(options: RelatedQueriesOptions): Promise<string>;
    dailyTrends(options: { trendDate: Date; geo: string }): Promise<string>;
    realTimeTrends(options: { geo: string; category?: string }): Promise<string>;
  };

  export default googleTrends;
}
