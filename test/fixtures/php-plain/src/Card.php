<?php

declare(strict_types=1);

namespace Fixture;

use Acme\Links\Link;

/**
 * Renders a card.
 *
 * @phpstan-type CardData array{
 *     title: string,
 *     tone?: 'light'|'dark',
 *     tags?: list<string>,
 * }
 * @phpstan-import-type LinkData from Link
 */
final class Card {

	public const DEFAULT_TONE = 'light';

	public function __construct( private readonly string $prefix = 'card' ) {}

	/**
	 * Render the card.
	 *
	 * @param CardData $card  Card content.
	 * @param array    $args {
	 *     Optional. Display settings.
	 *
	 *     @type string   $className Extra classes. Default empty.
	 *     @type LinkData $link      Link around the card.
	 *     @type bool     $echo      Whether to print. Default true.
	 * }
	 * @return string The HTML.
	 */
	public function render( array $card, array $args = [] ): string {
		$class = $args['className'] ?? '';
		$level = $args['level'] ?? 2;
		return sprintf( '<div class="%s %s">%s</div>', $this->prefix, $class, $card['title'] );
	}

	/**
	 * Helper with a defaults array.
	 */
	public static function make( array $options = [] ): self {
		$options = array_merge( [ 'prefix' => 'card', 'size' => 'md' ], $options );
		return new self( $options['prefix'] );
	}
}
