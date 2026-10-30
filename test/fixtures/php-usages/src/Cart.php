<?php

namespace Shop;

use Shop\Money\Formatter as Fmt;

trait Totals {
	public function total(): int {
		return 0;
	}
}

class Cart {
	use Totals;

	private Fmt $formatter;

	public function __construct() {
		$this->formatter = new Fmt();
	}

	public function render(): string {
		return $this->formatter->format( $this->total() );
	}

	public function register(): void {
		add_action( 'init', [ $this, 'render' ] );
		add_filter( 'the_content', [ self::class, 'filter' ] );
	}

	public static function filter( string $content ): string {
		return $content;
	}
}
