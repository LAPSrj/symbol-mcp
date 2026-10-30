<?php

namespace Shop\Money;

class Formatter {
	public function format( int $cents ): string {
		return (string) $cents;
	}
}
