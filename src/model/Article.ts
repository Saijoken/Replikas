import Database from './Database';
import TMDB from './TMDB';
import Buyer from './users/Buyer';

export default class Article {
	private id: number;
	private name: string;
	private description: string;
	private price: number;
	private min_bidding: number;
	private auction_start: Date;
	private auction_end: Date;
	private img_paths: string[] = [];
	private tmdb_movie_id: number;
	private selling_company_id: number;

	private constructor() {}

	/**
	 * Prend le résultat d'une requete a la {@link Database} (1 row) et retourne un {@link Article}
	 * Méthode utilitaire pour éviter du code dupliqué.
	 * @param result Le résultat d'une requete à la {@link Database} (1 row)
	 * @returns L'article correspondant au résultat
	 */
	private static async getFromResult(result: any): Promise<Article> {
		const database = Database.get();
		const article = new Article();
		article.id = result.art_id;
		article.name = result.art_name;
		article.description = result.art_description;
		article.price = result.art_price;
		article.min_bidding = result.art_min_bidding;
		article.auction_start = result.art_auction_start;
		article.auction_end = result.art_auction_end;
		article.tmdb_movie_id = result.m_id;
		article.selling_company_id = result.c_id;

		const imgs = await database`
			SELECT * FROM article_image WHERE art_id = ${article.id}`;
		for (const image of imgs) {
			article.img_paths.push(image.img_path);
		}

		return article;
	}

	/**
	 * Retourne l'article correspondant à l'id
	 * @param id L'id de l'article
	 * @returns L'article correspondant à l'id
	 * @throws {@link ArticleInexistantError} Si l'article n'existe pas
	 */
	public static async get(id: number): Promise<Article> {
		const database = Database.get();
		const result = await database`
            SELECT * FROM article WHERE art_id = ${id}`;
		if (result.count === 0) {
			throw new ArticleInexistantError(id);
		}
		return this.getFromResult(result[0]);
	}

	/**
	 * Crée un article
	 * @param name Le nom de l'article
	 * @param description La description de l'article
	 * @param price Le prix de l'article
	 * @param min_bidding Le prix minimum de l'article
	 * @param auction_start La date de début de l'enchère
	 * @param auction_end La date de fin de l'enchère
	 * @param img_paths Les chemins des images de l'article
	 * @param tmdb_movie_id L'id du film correspondant à l'article
	 * @param selling_company_id L'id de la société vendant l'article
	 * @returns L'article créé
	 */
	public static async create(
		name: string,
		description: string,
		price: number,
		min_bidding: number,
		auction_start: Date,
		auction_end: Date,
		img_paths: string[],
		tmdb_movie_id: number,
		selling_company_id: number
	): Promise<Article> {
		const movie = await TMDB.getMovie(tmdb_movie_id);
		const database = Database.get();

		const [result] = await database.begin(async (sql) => {
			await database`
			INSERT INTO movie (m_id, m_title) VALUES (${tmdb_movie_id}, ${movie.title}) ON CONFLICT DO NOTHING`;

			const result = await database`
            INSERT INTO article (art_name, art_description, art_price, art_min_bidding, art_auction_start, art_auction_end, m_id, c_id) VALUES (${name}, ${description}, ${price}, ${min_bidding}, ${auction_start}, ${auction_end}, ${tmdb_movie_id}, ${selling_company_id}) RETURNING *`;

			for (const img_path of img_paths) {
				await database`
					INSERT INTO article_image (art_id, img_path) VALUES (${result[0].art_id}, ${img_path})`;
			}

			return [result[0]];
		});

		return this.getFromResult(result);
	}

	/**
	 * Retourne tous les articles de la base de données
	 * @returns Tous les articles
	 */
	public static async getAll(): Promise<Article[]> {
		const database = Database.get();
		const result = await database`
			SELECT * FROM article`;
		const articles: Article[] = [];
		for (const article of result) {
			articles.push(await this.getFromResult(article));
		}

		return articles;
	}

	/**
	 * Exécute une recherche sur les articles
	 * @param search Les mots clés de la recherche
	 * @param params Les paramètres de la recherche
	 * @returns Les articles correspondant à la recherche
	 */
	public static async getBySearch(
		search: string,
		params = { limit: 20, offset: 0 }
	): Promise<Article[]> {
		if (search == '@all') {
			return this.getAll();
		}
		const database = Database.get();
		const t0 = performance.now();
		// Cherche les articles dont le nom, la description ou le nom de film contient le mot recherché (ts_query, ts_vector, plainto_tsquery), triés par pertinence (ts_rank)
		const result = await database`
            SELECT 
                    a.*, 
                    rank_name,
                    rank_description,
                    rank_movie_title,
                    similarity
            FROM 
                    article a INNER JOIN movie c ON a.m_id = c.m_id,
                    to_tsvector(a.art_name || ' ' || a.art_description || ' ' || c.m_title) document,
                    websearch_to_tsquery(${search}) query,
                    NULLIF(ts_rank(to_tsvector(a.art_name), query), 0) rank_name,
                    NULLIF(ts_rank(to_tsvector(a.art_description), query), 0) rank_description,
                    NULLIF(ts_rank(to_tsvector(c.m_title), query), 0) rank_movie_title,
                    SIMILARITY(${search}, a.art_name || a.art_description) similarity
            WHERE
                    document @@ query OR similarity > 0.08
            ORDER BY
                    rank_name DESC, rank_description DESC, rank_movie_title DESC, similarity DESC
			LIMIT ${params.limit} OFFSET ${params.offset || 0}`;

		const articles: Article[] = [];
		for (const article of result) {
			articles.push(await this.getFromResult(article));
		}
		const t1 = performance.now();
		console.info(`Search took ${t1 - t0} milliseconds.`);
		return articles;
	}

	/**
	 * @param params Les paramètres de la recherche
	 * @returns Les articles ayant le plus d'enchèrissements
	 */
	public static async mostBids(
		params = { limit: 8, offset: 0 }
	): Promise<Article[]> {
		const database = Database.get();
		const result = await database`
				SELECT * 
				FROM article
				WHERE art_id IN (
					SELECT art_id
					FROM bid
					GROUP BY art_id
					ORDER BY count(art_id) DESC
					LIMIT ${params.limit || 8} OFFSET ${params.offset || 0}
					)`;
		const articles: Article[] = [];
		for (const article of result) {
			articles.push(await this.getFromResult(article));
		}
		return articles;
	}

	/**
	 * @param buyer Le client qui veut savoir si il a aimé l'article
	 * @returns Si l'article est dans la liste des articles aimés du client
	 */
	public async isLikedBy(buyer: Buyer): Promise<boolean> {
		const database = Database.get();
		const result = await database`
			SELECT * FROM interests WHERE art_id = ${this.id} AND b_id = ${buyer.getId()}`;
		return result.length > 0;
	}

	/**
	 * Méthode utilitaire pour créer un faux article qui n'est pas dans la DB
	 * @param id L'id de l'article non trouvé
	 * @returns L'article de fallback
	 */
	public static getFallback(id: number): Article {
		const article = new Article();
		article.id = null;
		article.name = `Article ${id} non trouvé`;
		article.description = `Cet article n'existe pas ou plus`;
		article.price = 0;
		article.min_bidding = 0;
		article.auction_start = new Date();
		article.auction_end = new Date();
		article.tmdb_movie_id = null;
		article.selling_company_id = null;
		article.img_paths = ['/img/article/placeholder.jpg'];

		return article;
	}

	/**
	 * Supprime un article de la base de données
	 * @param id L'id de l'article à supprimer
	 */
	public async delete(): Promise<void> {
		const database = Database.get();
		await database`DELETE FROM article WHERE art_id = ${this.id}`;
		await database`DELETE FROM article_image WHERE art_id = ${this.id}`;
	}

	public getId(): number {
		return this.id;
	}

	public getName(): string {
		return this.name;
	}

	public getDescription(): string {
		return this.description;
	}

	public getPrixBase(): number {
		return this.price;
	}

	public getEncherissementMin(): number {
		return this.min_bidding;
	}

	public getDebutVente(): Date {
		return this.auction_start;
	}

	public getFinVente(): Date {
		return this.auction_end;
	}

	public getTmdbMovieId(): number {
		return this.tmdb_movie_id;
	}

	public getImages(): string[] {
		return this.img_paths;
	}

	/**
	 * @returns L'url de l'image principale de l'article, si il n'a pas d'images on va chercher le poster sur TMDB
	 */
	public async getPoster(): Promise<string> {
		if (this.img_paths.length > 0) {
			return this.img_paths[0];
		} else {
			return await TMDB.getMoviePosterURL(this.tmdb_movie_id, 'w342').catch(
				() => {
					return '/img/article/placeholder.jpg';
				}
			);
		}
	}

	public getSellingCompanyId(): number {
		return this.selling_company_id;
	}
}

export class ArticleInexistantError extends Error {
	constructor(id: number) {
		super(`L'article ${id} n'existe pas`);
	}
}